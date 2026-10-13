import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, createApiClient, normalizeServerUrl, parseUserInfo } from './api-client';

describe('normalizeServerUrl', () => {
  it('keeps scheme, host and port only', () => {
    expect(normalizeServerUrl('  https://concord.duckdns.org/  ')).toBe(
      'https://concord.duckdns.org',
    );
    expect(normalizeServerUrl('http://192.168.0.10:3000/api/')).toBe('http://192.168.0.10:3000');
    expect(normalizeServerUrl('https://user:pw@host.example/x?y=1#z')).toBe('https://host.example');
    expect(normalizeServerUrl('HTTP://Example.COM:80')).toBe('https://example.com');
  });

  it('rejects empty input, missing or unsupported schemes and garbage', () => {
    const message = (input: string): string => {
      try {
        normalizeServerUrl(input);
      } catch (err) {
        expect(err).toBeInstanceOf(ApiClientError);
        return (err as ApiClientError).message;
      }
      return 'no error';
    };
    expect(message('   ')).toBe('Informe a URL do servidor.');
    expect(message('concord.duckdns.org')).toMatch(/http:\/\/ ou https:\/\//);
    expect(message('localhost:3000')).toMatch(/http:\/\/ ou https:\/\//);
    expect(message('ftp://host')).toMatch(/http:\/\/ ou https:\/\//);
    expect(message('http://')).toMatch(/inválida/);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function client(fetchImpl: typeof fetch, key: string | null = 'secret') {
  return createApiClient({
    getServerUrl: () => 'http://127.0.0.1:3000/',
    getKey: () => key,
    fetchImpl,
  });
}

async function failure(promise: Promise<unknown>): Promise<ApiClientError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiClientError);
    return err as ApiClientError;
  }
  throw new Error('expected the call to fail');
}

describe('createApiClient', () => {
  it('sends the Authorization header and parses /api/me', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:3000/api/me');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse(200, { user: { id: 'bryan', displayName: 'Bryan', admin: true } });
    });
    const user = await client(fetchImpl as typeof fetch).me();
    // An older server without profile fields: they come back as null.
    expect(user).toEqual({
      id: 'bryan',
      displayName: 'Bryan',
      admin: true,
      avatarUrl: null,
      discordName: null,
      nickname: null,
    });
  });

  it('parses /api/rooms', async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { rooms: ['geral', 'jogos'] })) as typeof fetch;
    expect(await client(fetchImpl).rooms()).toEqual(['geral', 'jogos']);
  });

  it('posts the room to /api/token and parses the response', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:3000/api/token');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({ room: 'jogos' });
      return jsonResponse(200, { token: 'jwt', url: 'ws://127.0.0.1:7880', expiresAt: 123 });
    });
    const token = await client(fetchImpl as typeof fetch).token('jogos');
    expect(token).toEqual({ token: 'jwt', url: 'ws://127.0.0.1:7880', expiresAt: 123 });
  });

  it('posts the token purpose when given', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ room: 'jogos', purpose: 'popout' });
      return jsonResponse(200, { token: 'jwt', url: 'ws://127.0.0.1:7880', expiresAt: 123 });
    });
    await client(fetchImpl as typeof fetch).token('jogos', 'popout');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a network failure to a pt-BR message with the host', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await failure(client(fetchImpl).me());
    expect(err.kind).toBe('network');
    expect(err.message).toBe(
      'Não foi possível conectar ao servidor 127.0.0.1:3000. Verifique a URL e se o servidor está no ar.',
    );
  });

  it('maps a timeout', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    const err = await failure(client(fetchImpl).me());
    expect(err.kind).toBe('timeout');
    expect(err.message).toMatch(/127\.0\.0\.1:3000 demorou demais/);
  });

  it('maps 401 and 429 regardless of the body', async () => {
    const unauthorized = await failure(
      client((async () =>
        jsonResponse(401, { error: 'x', message: 'ignored' })) as typeof fetch).me(),
    );
    expect(unauthorized.kind).toBe('unauthorized');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.message).toBe('Chave de acesso inválida.');

    const limited = await failure(
      client((async () => new Response('', { status: 429 })) as typeof fetch).me(),
    );
    expect(limited.kind).toBe('rate_limited');
    expect(limited.message).toBe('Muitas tentativas. Aguarde um minuto.');
  });

  it('uses the message of a JSON ApiErrorResponse', async () => {
    const fetchImpl = (async () =>
      jsonResponse(400, { error: 'unknown_room', message: 'Sala desconhecida.' })) as typeof fetch;
    const err = await failure(client(fetchImpl).token('nope'));
    expect(err.kind).toBe('http');
    expect(err.status).toBe(400);
    expect(err.code).toBe('unknown_room');
    expect(err.message).toBe('Sala desconhecida.');
  });

  it('falls back to a generic message for other statuses', async () => {
    const fetchImpl = (async () =>
      new Response('<html>bad gateway</html>', { status: 502 })) as typeof fetch;
    const err = await failure(client(fetchImpl).rooms());
    expect(err.kind).toBe('http');
    expect(err.message).toBe('Erro inesperado do servidor (502).');
  });

  it('rejects malformed success bodies', async () => {
    const notJson = (async () => new Response('nope', { status: 200 })) as typeof fetch;
    expect((await failure(client(notJson).me())).kind).toBe('bad_response');
    const wrongShape = (async () => jsonResponse(200, { user: { id: 1 } })) as typeof fetch;
    expect((await failure(client(wrongShape).me())).message).toBe(
      'Resposta inesperada do servidor.',
    );
  });

  it('fails before fetching when no key is stored or the URL is invalid', async () => {
    const fetchImpl = vi.fn();
    const noKey = await failure(client(fetchImpl as unknown as typeof fetch, null).me());
    expect(noKey.kind).toBe('no_key');
    const badUrl = createApiClient({
      getServerUrl: () => 'not a url',
      getKey: () => 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect((await failure(badUrl.me())).kind).toBe('invalid_url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('parseUserInfo', () => {
  const avatarUrl = 'https://cdn.discordapp.com/avatars/123/abc.png';

  it('keeps the Discord profile fields', () => {
    expect(
      parseUserInfo({
        id: 'bryan',
        displayName: 'Bryzinho',
        admin: false,
        avatarUrl,
        discordName: 'Bryan',
        nickname: 'Bryzinho',
        extra: 'dropped',
      }),
    ).toEqual({
      id: 'bryan',
      displayName: 'Bryzinho',
      admin: false,
      avatarUrl,
      discordName: 'Bryan',
      nickname: 'Bryzinho',
    });
  });

  it('turns missing or malformed profile fields into null', () => {
    expect(
      parseUserInfo({
        id: 'bryan',
        displayName: 'Bryan',
        admin: 'yes',
        avatarUrl: 'https://evil.example/a.png',
        discordName: 7,
        nickname: '   ',
      }),
    ).toEqual({
      id: 'bryan',
      displayName: 'Bryan',
      admin: false,
      avatarUrl: null,
      discordName: null,
      nickname: null,
    });
  });

  it('rejects users without id or displayName', () => {
    expect(parseUserInfo(null)).toBeNull();
    expect(parseUserInfo({ id: 'bryan' })).toBeNull();
    expect(parseUserInfo({ displayName: 'Bryan' })).toBeNull();
    expect(parseUserInfo([])).toBeNull();
  });
});

describe('setNickname', () => {
  const updated = {
    id: 'bryan',
    displayName: 'Bryzinho',
    admin: false,
    avatarUrl: null,
    discordName: 'Bryan',
    nickname: 'Bryzinho',
  };

  it('PUTs the nickname as JSON and parses the returned user', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:3000/api/me/nickname');
      expect(init?.method).toBe('PUT');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer secret');
      expect(headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual({ nickname: 'Bryzinho' });
      return jsonResponse(200, { user: updated });
    });
    expect(await client(fetchImpl as typeof fetch).setNickname('Bryzinho')).toEqual(updated);
  });

  it('sends null to go back to the Discord name', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ nickname: null });
      return jsonResponse(200, { user: { ...updated, displayName: 'Bryan', nickname: null } });
    });
    const user = await client(fetchImpl as typeof fetch).setNickname(null);
    expect(user.nickname).toBeNull();
    expect(user.displayName).toBe('Bryan');
  });

  it('maps errors like every other call', async () => {
    const invalid = await failure(
      client((async () =>
        jsonResponse(400, {
          error: 'invalid_nickname',
          message: 'O nome deve ter de 1 a 32 caracteres.',
        })) as typeof fetch).setNickname('x'),
    );
    expect(invalid.kind).toBe('http');
    expect(invalid.code).toBe('invalid_nickname');
    expect(invalid.message).toBe('O nome deve ter de 1 a 32 caracteres.');

    const unauthorized = await failure(
      client((async () => new Response('', { status: 401 })) as typeof fetch).setNickname('x'),
    );
    expect(unauthorized.kind).toBe('unauthorized');

    const malformed = await failure(
      client((async () => jsonResponse(200, { ok: true })) as typeof fetch).setNickname('x'),
    );
    expect(malformed.kind).toBe('bad_response');
  });
});

describe('normalizeServerUrl https upgrade (main)', () => {
  it('upgrades a stored http public domain and keeps local addresses', () => {
    expect(normalizeServerUrl('http://exemplo.duckdns.org/')).toBe(
      'https://exemplo.duckdns.org',
    );
    expect(normalizeServerUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(normalizeServerUrl('http://localhost')).toBe('http://localhost');
    expect(normalizeServerUrl('http://friend.duckdns.org:3000')).toBe(
      'http://friend.duckdns.org:3000',
    );
  });
});
