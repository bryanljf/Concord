import type { JamEvent, JamItem, PresenceEvent } from '@concord/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PresenceConnectionStatus } from '../preload/api';
import { ApiClientError, type ApiClient } from './api-client';
import {
  backoffDelay,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  PresenceClient,
  type PresenceClientOptions,
} from './presence-client';

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

  function setup(fetchImpl: typeof fetch, options: Partial<PresenceClientOptions> = {}) {
    const client = new PresenceClient({
      getServerUrl: () => 'http://127.0.0.1:3000',
      getKey: () => 'key',
      fetchImpl,
      stallTimeoutMs: 1_000,
      connectTimeoutMs: 500,
      backoff: (attempt) => attempt * 100,
      ...options,
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

  it('asks for the jam events and routes them to the jam store', async () => {
    const streams: ReturnType<typeof sseResponse>[] = [];
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      const stream = sseResponse(init?.signal ?? undefined);
      streams.push(stream);
      return stream.response;
    });
    const { client, events } = setup(fetchImpl as typeof fetch);
    const jamEvents: JamEvent[] = [];
    client.jam.onEvent((event) => jamEvents.push(event));
    expect(client.jam.get()).toEqual({ available: false, rooms: {}, serverTime: 0 });

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toEqual(['http://127.0.0.1:3000/api/presence?jam=1']);

    const jamSnapshot: JamEvent = {
      type: 'jam_snapshot',
      data: { available: true, rooms: {}, serverTime: 5 },
    };
    streams[0]?.push(`data: ${JSON.stringify(snapshotEvent)}\n\n`);
    streams[0]?.push(`data: ${JSON.stringify(jamSnapshot)}\n\n`);
    // Malformed: dropped without touching presence or the jam.
    streams[0]?.push('data: {"type":"jam_updated","state":{"room":"geral"},"serverTime":6}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.map((event) => event.type)).toEqual(['snapshot']);
    expect(jamEvents).toEqual([jamSnapshot]);
    expect(client.jam.get()).toEqual(jamSnapshot.data);

    // Dropped connections keep the jam until the server resends it.
    streams[0]?.end();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.jam.get().available).toBe(true);

    client.disconnect('no_session');
    expect(client.jam.get()).toEqual({ available: false, rooms: {}, serverTime: 0 });
    expect(jamEvents.at(-1)).toEqual({
      type: 'jam_snapshot',
      data: { available: false, rooms: {}, serverTime: 0 },
    });
  });

  it('drops the jam of the previous server when connecting to another one', async () => {
    let serverUrl = 'http://127.0.0.1:3000';
    const streams: ReturnType<typeof sseResponse>[] = [];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const stream = sseResponse(init?.signal ?? undefined);
      streams.push(stream);
      return stream.response;
    });
    const client = new PresenceClient({
      getServerUrl: () => serverUrl,
      getKey: () => 'key',
      fetchImpl: fetchImpl as typeof fetch,
      backoff: () => 100,
    });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    streams[0]?.push(
      `data: ${JSON.stringify({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: 1 } })}\n\n`,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(client.jam.get().available).toBe(true);

    serverUrl = 'http://127.0.0.1:4000';
    client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.jam.get().available).toBe(false);
    client.disconnect('no_session');
  });

  // ---------------------------------------------------------------------------
  // Delegated fetches (downloads the server asks this app to do for other clients)
  // ---------------------------------------------------------------------------

  describe('delegated fetches', () => {
    const item: JamItem = {
      id: 'item-1',
      track: {
        videoId: '4D7u5KF7SP8',
        title: 'Get Lucky',
        artists: 'Daft Punk',
        album: null,
        durationMs: 370_000,
        artworkUrl: null,
      },
      requestedBy: 'ana',
      addedAt: 1,
      status: 'downloading',
    };

    /** A connected fetch-enabled client, its stream and everything it may have emitted. */
    async function connectFetching(options: Partial<PresenceClientOptions> = {}) {
      const streams: ReturnType<typeof sseResponse>[] = [];
      const urls: string[] = [];
      const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        urls.push(String(input));
        const stream = sseResponse(init?.signal ?? undefined);
        streams.push(stream);
        return stream.response;
      });
      const jamFetchPong = vi.fn<ApiClient['jamFetchPong']>(async () => undefined);
      const { client, events, statuses } = setup(fetchImpl as typeof fetch, {
        fetch: () => true,
        api: { jamFetchPong },
        ...options,
      });
      const jamEvents: JamEvent[] = [];
      client.jam.onEvent((event) => jamEvents.push(event));
      const requests: [string, JamItem][] = [];
      client.onFetchRequest((room, requested) => requests.push([room, requested]));
      client.connect();
      await vi.advanceTimersByTimeAsync(0);
      const push = async (payload: unknown): Promise<void> => {
        streams[0]?.push(`data: ${JSON.stringify(payload)}\n\n`);
        await vi.advanceTimersByTimeAsync(0);
      };
      return { client, fetchImpl, urls, events, statuses, jamEvents, requests, jamFetchPong, push };
    }

    it('asks for the fetch requests only where downloading is possible', async () => {
      let windows = false;
      const { client, urls } = await connectFetching({ fetch: () => windows });
      expect(urls).toEqual(['http://127.0.0.1:3000/api/presence?jam=1']);
      // Checked on every connection, not once.
      windows = true;
      client.reconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(urls[1]).toBe('http://127.0.0.1:3000/api/presence?jam=1&fetch=1');
      client.disconnect('no_session');

      const never = await connectFetching({ fetch: undefined });
      expect(never.urls).toEqual(['http://127.0.0.1:3000/api/presence?jam=1']);
      never.client.disconnect('no_session');
    });

    it('answers the pings at once and only logs when it cannot', async () => {
      const { client, events, jamEvents, requests, jamFetchPong, push, statuses } =
        await connectFetching();
      await push({ type: 'jam_fetch_ping', nonce: 'n1' });
      expect(jamFetchPong).toHaveBeenCalledWith('n1');
      // A failed pong is nobody's problem but the server's ranking.
      jamFetchPong.mockRejectedValueOnce(new ApiClientError('network', 'offline'));
      await push({ type: 'jam_fetch_ping', nonce: 'n2' });
      expect(jamFetchPong).toHaveBeenCalledTimes(2);
      // Malformed pings are dropped.
      await push({ type: 'jam_fetch_ping' });
      await push({ type: 'jam_fetch_ping', nonce: 'has space' });
      await push({ type: 'jam_fetch_ping', nonce: 42 });
      expect(jamFetchPong).toHaveBeenCalledTimes(2);
      // Nothing of this is a presence or jam event, and the stream goes on.
      expect(events).toEqual([]);
      expect(jamEvents).toEqual([]);
      expect(requests).toEqual([]);
      expect(client.getSnapshot()).toEqual({ rooms: {} });
      expect(statuses.at(-1)).toEqual({ state: 'connected' });
      client.disconnect('no_session');
    });

    it('drops the pings when there is no api client to answer them', async () => {
      const { client, push, statuses } = await connectFetching({ api: undefined });
      await push({ type: 'jam_fetch_ping', nonce: 'n1' });
      expect(statuses.at(-1)).toEqual({ state: 'connected' });
      client.disconnect('no_session');
    });

    it('emits validated fetch requests and drops malformed ones', async () => {
      const { client, events, jamEvents, requests, jamFetchPong, push } = await connectFetching();
      await push({ type: 'jam_fetch', room: 'sala-1', item: { ...item, extra: 1 } });
      await push({ type: 'jam_fetch', room: 'sala com espaço', item });
      await push({ type: 'jam_fetch', room: 'sala-1', item: { ...item, id: '' } });
      await push({ type: 'jam_fetch', room: 'sala-1', item: { ...item, requestedBy: 'Not A' } });
      await push({ type: 'jam_fetch', room: 'sala-1' });
      await push({ type: 'jam_fetch', item });
      // Unknown fields dropped, the rest as the server sent it.
      expect(requests).toEqual([['sala-1', item]]);
      expect(events).toEqual([]);
      expect(jamEvents).toEqual([]);
      expect(jamFetchPong).not.toHaveBeenCalled();
      expect(client.jam.get()).toEqual({ available: false, rooms: {}, serverTime: 0 });

      // Presence and jam events keep flowing around them.
      await push(snapshotEvent);
      await push({ type: 'jam_fetch', room: 'sala-2', item: { ...item, id: 'item-2' } });
      expect(events.map((event) => event.type)).toEqual(['snapshot']);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(['sala-2', { ...item, id: 'item-2' }]);

      // Unsubscribed listeners hear nothing more.
      const late = vi.fn();
      const unsubscribe = client.onFetchRequest(late);
      unsubscribe();
      await push({ type: 'jam_fetch', room: 'sala-1', item: { ...item, id: 'item-3' } });
      expect(late).not.toHaveBeenCalled();
      expect(requests).toHaveLength(3);
      client.disconnect('no_session');
    });
  });
});
