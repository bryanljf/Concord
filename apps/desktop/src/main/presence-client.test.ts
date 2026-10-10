import type { PresenceEvent } from '@concord/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceConnectionStatus } from '../preload/api';
import { backoffDelay, BACKOFF_MAX_MS, BACKOFF_MIN_MS, PresenceClient } from './presence-client';

describe('backoffDelay', () => {
  it('doubles from 1 s and caps at 30 s', () => {
    const noJitter = () => 0.5;
    expect(backoffDelay(1, noJitter)).toBe(1_000);
    expect(backoffDelay(2, noJitter)).toBe(2_000);
    expect(backoffDelay(3, noJitter)).toBe(4_000);
    expect(backoffDelay(5, noJitter)).toBe(16_000);
    expect(backoffDelay(6, noJitter)).toBe(30_000);
    expect(backoffDelay(50, noJitter)).toBe(30_000);
  });

  it('applies ±20% jitter within [1 s, 30 s]', () => {
    expect(backoffDelay(3, () => 0)).toBe(3_200);
    expect(backoffDelay(3, () => 1)).toBe(4_800);
    expect(backoffDelay(1, () => 0)).toBe(BACKOFF_MIN_MS);
    expect(backoffDelay(6, () => 1)).toBe(BACKOFF_MAX_MS);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (let i = 0; i < 20; i += 1) {
        const delay = backoffDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(BACKOFF_MIN_MS);
        expect(delay).toBeLessThanOrEqual(BACKOFF_MAX_MS);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Connection state machine with a scripted fetch
// ---------------------------------------------------------------------------

/** A fake SSE response whose body is fed by the test; like a real fetch, it errors on abort. */
function sseResponse(signal?: AbortSignal): {
  response: Response;
  push(text: string): void;
  end(): void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      controller = ctrl;
    },
  });
  signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  const encoder = new TextEncoder();
  return {
    response: new Response(stream, { status: 200 }),
    push: (text) => controller.enqueue(encoder.encode(text)),
    end: () => controller.close(),
  };
}

const snapshotEvent: PresenceEvent = {
  type: 'snapshot',
  data: { rooms: { geral: [{ id: 'ana', name: 'Ana', streaming: false, joinedAt: 1 }] } },
};

describe('PresenceClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(fetchImpl: typeof fetch) {
    const client = new PresenceClient({
      getServerUrl: () => 'http://127.0.0.1:3000',
      getKey: () => 'key',
      fetchImpl,
      stallTimeoutMs: 1_000,
      connectTimeoutMs: 500,
      backoff: (attempt) => attempt * 100,
    });
    const statuses: PresenceConnectionStatus[] = [];
    const events: PresenceEvent[] = [];
    client.onStatus((status) => statuses.push(status));
    client.onEvent((event) => events.push(event));
    return { client, statuses, events };
  }

  it('connects, applies events, reconnects after a stall and clears on disconnect', async () => {
    const streams: ReturnType<typeof sseResponse>[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer key');
      expect((init?.headers as Record<string, string>).Accept).toBe('text/event-stream');
      const stream = sseResponse(init?.signal ?? undefined);
      streams.push(stream);
      return stream.response;
    });
    const { client, statuses, events } = setup(fetchImpl as typeof fetch);

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual([{ state: 'connecting', attempt: 1 }, { state: 'connected' }]);

    streams[0]?.push(`: ping\n\ndata: ${JSON.stringify(snapshotEvent)}\n\n`);
    streams[0]?.push('data: {"type":"stream_started","room":"geral","participantId":"ana"}\n\n');
    streams[0]?.push('data: not json\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(2);
    expect(client.getSnapshot().rooms.geral?.[0]?.streaming).toBe(true);

    // Silence for the whole stall timeout aborts the request and schedules a reconnect.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses.at(-1)).toEqual({
      state: 'error',
      message: 'O servidor parou de responder.',
      retryInMs: 100,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toEqual({ state: 'connected' });
    // The last snapshot survives the reconnect gap until the server sends a new one.
    expect(client.getSnapshot().rooms.geral).toHaveLength(1);

    client.disconnect('discord_closed');
    expect(events.at(-1)).toEqual({ type: 'snapshot', data: { rooms: {} } });
    expect(client.getStatus()).toEqual({ state: 'idle', reason: 'discord_closed' });
    expect(client.getSnapshot()).toEqual({ rooms: {} });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('backs off with increasing attempts after network failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const { client, statuses } = setup(fetchImpl as typeof fetch);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual([
      { state: 'connecting', attempt: 1 },
      {
        state: 'error',
        message:
          'Não foi possível conectar ao servidor 127.0.0.1:3000. Verifique a URL e se o servidor está no ar.',
        retryInMs: 100,
      },
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-2)).toEqual({ state: 'connecting', attempt: 2 });
    expect(statuses.at(-1)).toMatchObject({ state: 'error', retryInMs: 200 });
    client.disconnect('no_session');
  });

  it('stops retrying on 401 until reconnect() is called', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const { client, statuses } = setup(fetchImpl as typeof fetch);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toEqual({
      state: 'error',
      message: 'Chave de acesso inválida.',
      retryInMs: 0,
    });
    expect(client.isActive).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    client.disconnect('no_session');
  });

  it('retries when the server closes the stream or answers with another status', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 503 });
      const stream = sseResponse();
      stream.end();
      return stream.response;
    });
    const { client, statuses } = setup(fetchImpl as typeof fetch);
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      message: 'Erro inesperado do servidor (503).',
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      message: 'A conexão com o servidor foi encerrada.',
    });
    client.disconnect('no_session');
  });
});
