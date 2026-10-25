import { describe, expect, it } from 'vitest';
import { emptyResponse, jsonResponse, scriptedFetch } from './fakes';
import {
  BAD_RESPONSE_MESSAGE,
  createHttp,
  errorFromResponse,
  JAM_ERROR_MESSAGES,
  JAM_UNSUPPORTED_SERVER_MESSAGE,
  jamErrorFromResponse,
  RATE_LIMITED_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
  timeoutErrorMessage,
  unexpectedStatusMessage,
} from './http';

describe('errorFromResponse', () => {
  it('maps the api error shape, 401, 429 and anything else', async () => {
    await expect(errorFromResponse(jsonResponse(401, {}))).resolves.toMatchObject({
      kind: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
      status: 401,
    });
    await expect(errorFromResponse(emptyResponse(429))).resolves.toMatchObject({
      kind: 'rate_limited',
      message: RATE_LIMITED_MESSAGE,
    });
    await expect(
      errorFromResponse(jsonResponse(403, { error: 'csrf', message: 'Requisição recusada.' })),
    ).resolves.toMatchObject({ kind: 'http', code: 'csrf', message: 'Requisição recusada.' });
    await expect(errorFromResponse(emptyResponse(502))).resolves.toMatchObject({
      kind: 'http',
      message: unexpectedStatusMessage(502),
    });
  });
});

describe('jamErrorFromResponse', () => {
  it('uses the app wording for known codes and detects a server without the Jam', async () => {
    await expect(
      jamErrorFromResponse(jsonResponse(409, { error: 'queue_full', message: 'x' })),
    ).resolves.toMatchObject({ code: 'queue_full', message: JAM_ERROR_MESSAGES.queue_full });
    await expect(jamErrorFromResponse(emptyResponse(404))).resolves.toMatchObject({
      message: JAM_UNSUPPORTED_SERVER_MESSAGE,
    });
    await expect(
      jamErrorFromResponse(jsonResponse(503, { error: 'no_downloader', message: 'Ninguém.' })),
    ).resolves.toMatchObject({ code: 'no_downloader', message: 'Ninguém.' });
  });
});

describe('createHttp', () => {
  it('sends JSON with the cookie and parses the answer', async () => {
    const { fetchImpl, calls } = scriptedFetch(() => jsonResponse(200, { value: 1 }));
    const http = createHttp({ host: 'concord.test', fetchImpl });
    const parse = (json: unknown): number | null =>
      typeof json === 'object' && json !== null && 'value' in json ? 1 : null;
    await expect(http.request('/api/x', parse, { a: 1 })).resolves.toBe(1);
    expect(calls[0]).toMatchObject({
      path: '/api/x',
      init: {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      },
      json: { a: 1 },
    });
    await expect(http.request('/api/x', () => null)).rejects.toMatchObject({
      kind: 'bad_response',
      message: BAD_RESPONSE_MESSAGE,
    });
  });

  it('reports a body that is not JSON, timeouts and network failures', async () => {
    const text = createHttp({
      host: 'concord.test',
      fetchImpl: async () => new Response('<html>', { status: 200 }),
    });
    await expect(text.request('/api/x', () => 1)).rejects.toMatchObject({ kind: 'bad_response' });

    const slow = createHttp({
      host: 'concord.test',
      timeoutMs: 10,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    await expect(slow.request('/api/x', () => 1)).rejects.toMatchObject({
      kind: 'timeout',
      message: timeoutErrorMessage('concord.test'),
    });

    const offline = createHttp({
      host: 'concord.test',
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(offline.ping()).rejects.toMatchObject({ kind: 'network' });
  });

  it('command drops the body; ping measures the health route', async () => {
    const { fetchImpl, calls } = scriptedFetch((path) =>
      path === '/api/health' ? jsonResponse(200, { ok: true }) : emptyResponse(204),
    );
    const http = createHttp({ host: 'concord.test', fetchImpl });
    await expect(http.command('/api/x', 'DELETE')).resolves.toBeUndefined();
    expect(calls[0]?.init?.method).toBe('DELETE');
    await expect(http.ping()).resolves.toBeGreaterThanOrEqual(0);
    expect(calls[1]).toMatchObject({
      path: '/api/health',
      init: { cache: 'no-store', credentials: 'same-origin' },
    });
  });
});
