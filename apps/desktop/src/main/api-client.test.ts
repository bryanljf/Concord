import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
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
    expect(normalizeServerUrl('http://exemplo.duckdns.org/')).toBe('https://exemplo.duckdns.org');
    expect(normalizeServerUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(normalizeServerUrl('http://localhost')).toBe('http://localhost');
    expect(normalizeServerUrl('http://friend.duckdns.org:3000')).toBe(
      'http://friend.duckdns.org:3000',
    );
  });
});

describe('jam routes', () => {
  const track = {
    videoId: '4D7u5KF7SP8',
    title: 'Get Lucky',
    artists: 'Daft Punk, Pharrell Williams',
    album: null,
    durationMs: 370_000,
    artworkUrl: null,
  };
  const item = { id: 'item-1', track, requestedBy: 'bryan', addedAt: 1, status: 'downloading' };

  function capture(response: () => Response) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return response();
    });
    return { api: client(fetchImpl as typeof fetch), calls };
  }

  const noContent = () => new Response(null, { status: 204 });
  const headersOf = (init: RequestInit | undefined) => init?.headers as Record<string, string>;

  it('searches with an encoded query and skips malformed results', async () => {
    const { api, calls } = capture(() =>
      jsonResponse(200, {
        results: [track, { ...track, videoId: 'bad' }, { ...track, title: 'B' }],
      }),
    );
    expect(await api.jamSearch('daft punk & co')).toEqual({
      results: [track, { ...track, title: 'B' }],
      cached: [],
    });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/api/jam/search?q=daft%20punk%20%26%20co');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(headersOf(calls[0]?.init).Authorization).toBe('Bearer secret');
  });

  it('caps the search results and rejects a body without them', async () => {
    const many = Array.from({ length: 30 }, () => track);
    const { results } = await capture(() => jsonResponse(200, { results: many })).api.jamSearch(
      'x',
    );
    expect(results).toHaveLength(20);
    const err = await failure(capture(() => jsonResponse(200, { tracks: [] })).api.jamSearch('x'));
    expect(err.kind).toBe('bad_response');
  });

  it('reads which results the server already has', async () => {
    const { api } = capture(() =>
      jsonResponse(200, { results: [track], cached: [track.videoId, 'bad', 42, null] }),
    );
    expect(await api.jamSearch('x')).toEqual({ results: [track], cached: [track.videoId] });
    const odd = capture(() => jsonResponse(200, { results: [track], cached: 'all' }));
    expect((await odd.api.jamSearch('x')).cached).toEqual([]);
  });

  it('enqueues a video and parses the item', async () => {
    const { api, calls } = capture(() => jsonResponse(200, { item, upload: true }));
    expect(await api.jamEnqueue('sala-1', '4D7u5KF7SP8')).toEqual({ item, upload: true });
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/api/rooms/sala-1/jam/queue');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(headersOf(calls[0]?.init)['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ videoId: '4D7u5KF7SP8' });

    const malformed = capture(() => jsonResponse(200, { item: { ...item, id: '' }, upload: true }));
    expect((await failure(malformed.api.jamEnqueue('sala-1', '4D7u5KF7SP8'))).kind).toBe(
      'bad_response',
    );
  });

  it('uploads the audio as audio/webm', async () => {
    const { api, calls } = capture(noContent);
    const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
    await api.jamUpload('sala-1', 'item-1', audio);
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/api/rooms/sala-1/jam/items/item-1/audio');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(headersOf(calls[0]?.init)['Content-Type']).toBe('audio/webm');
    expect(calls[0]?.init?.body).toBe(audio);
    expect(calls[0]?.init?.duplex).toBeUndefined();
  });

  it('streams a body chunked, as it is read', async () => {
    const chunks: Buffer[] = [];
    let headers: IncomingHttpHeaders = {};
    let sawFirst: () => void = () => undefined;
    const firstArrived = new Promise<void>((resolve) => {
      sawFirst = resolve;
    });
    const server = createServer((req, res) => {
      headers = req.headers;
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        sawFirst();
      });
      req.on('end', () => {
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const api = createApiClient({
        getServerUrl: () => `http://127.0.0.1:${port}`,
        getKey: () => 'secret',
      });
      let step = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            step += 1;
            if (step === 1) controller.enqueue(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
            else if (step === 2) {
              // The server has the first bytes before the next ones even exist.
              await firstArrived;
              controller.enqueue(Buffer.from([1, 2, 3]));
            } else controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      await api.jamUpload('sala-1', 'item-1', body);
      expect(headers['transfer-encoding']).toBe('chunked');
      expect(headers['content-type']).toBe('audio/webm');
      expect(headers.authorization).toBe('Bearer secret');
      expect(Buffer.concat(chunks)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]));
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('takes an answer that comes while the body is still being sent', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify({ error: 'item_not_found', message: 'Not found' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const api = createApiClient({
        getServerUrl: () => `http://127.0.0.1:${port}`,
        getKey: () => 'secret',
      });
      // A body that never ends: only the early answer can end the request.
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.enqueue(new Uint8Array(16 * 1024));
          },
        },
        { highWaterMark: 0 },
      );
      const err = await failure(api.jamUpload('sala-1', 'item-1', body));
      expect(err.status).toBe(404);
      expect(err.code).toBe('item_not_found');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('reports a cancelled upload as such', async () => {
    const controller = new AbortController();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      controller.abort();
      throw init?.signal?.reason ?? new Error('aborted');
    }) as typeof fetch;
    const err = await failure(
      client(fetchImpl).jamUpload('sala-1', 'item-1', Buffer.alloc(1), controller.signal),
    );
    expect(err.kind).toBe('cancelled');
  });

  it('removes, skips, pauses and resumes', async () => {
    const { api, calls } = capture(noContent);
    await api.jamRemove('sala-1', 'item-1');
    await api.jamSkip('sala-1', 'item-1');
    await api.jamPause('sala-1');
    await api.jamResume('sala-1');
    expect(calls.map((call) => `${call.init?.method} ${call.url}`)).toEqual([
      'DELETE http://127.0.0.1:3000/api/rooms/sala-1/jam/items/item-1',
      'POST http://127.0.0.1:3000/api/rooms/sala-1/jam/skip',
      'POST http://127.0.0.1:3000/api/rooms/sala-1/jam/pause',
      'POST http://127.0.0.1:3000/api/rooms/sala-1/jam/resume',
    ]);
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ itemId: 'item-1' });
    // No body: no JSON Content-Type for Fastify to choke on.
    expect(calls[2]?.init?.body).toBeUndefined();
    expect(headersOf(calls[2]?.init)['Content-Type']).toBeUndefined();
  });

  it('uses its own pt-BR message for every jam error code', async () => {
    const errorOf = async (status: number, body: unknown) =>
      failure(capture(() => jsonResponse(status, body)).api.jamPause('sala-1'));

    const notInRoom = await errorOf(403, { error: 'not_in_room', message: 'Forbidden' });
    expect(notInRoom.message).toBe('Entre na sala para mexer na Jam.');
    expect(notInRoom.code).toBe('not_in_room');
    expect(notInRoom.status).toBe(403);
    expect((await errorOf(409, { error: 'queue_full', message: 'x' })).message).toBe(
      'A fila da Jam está cheia (50 músicas). Espere algumas tocarem.',
    );
    expect((await errorOf(422, { error: 'too_long', message: 'x' })).message).toBe(
      'Essa música é longa demais para a Jam (máximo de 20 minutos).',
    );
    expect((await errorOf(404, { error: 'track_not_found', message: 'x' })).message).toBe(
      'Essa música não foi encontrada no YouTube Music.',
    );
    expect((await errorOf(503, { error: 'jam_unavailable', message: 'x' })).code).toBe(
      'jam_unavailable',
    );
    expect((await errorOf(409, { error: 'stale', message: 'x' })).code).toBe('stale');
    // A server from before the Jam: its generic 404.
    expect(
      (await errorOf(404, { error: 'not_found', message: 'Rota não encontrada.' })).message,
    ).toBe('Este servidor ainda não tem a Jam. Peça para atualizarem o concord-api.');
    expect((await errorOf(413, { error: 'payload_too_large', message: 'x' })).message).toBe(
      'O áudio dessa música é grande demais para a Jam.',
    );
    // Unknown codes keep the server's message; 401 stays the usual one.
    expect((await errorOf(400, { error: 'other', message: 'Outra coisa.' })).message).toBe(
      'Outra coisa.',
    );
    expect((await errorOf(401, { error: 'x', message: 'y' })).kind).toBe('unauthorized');
  });

  it('maps errors of the regular routes as before', async () => {
    const err = await failure(
      capture(() =>
        jsonResponse(404, { error: 'not_found', message: 'Rota não encontrada.' }),
      ).api.me(),
    );
    expect(err.message).toBe('Rota não encontrada.');
  });
});
