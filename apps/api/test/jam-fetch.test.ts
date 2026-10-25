import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JAM_FETCH_MAX_ASSIGNMENTS,
  JAM_FETCH_START_TIMEOUT_MS,
  webIdentity,
  type ApiErrorResponse,
  type JamEnqueueResponse,
  type JamFetchEvent,
  type JamItem,
  type RoomId,
} from '@concord/shared';
import { UserStore, type User } from '../src/auth';
import { JamFetchers } from '../src/jam/fetchers';
import { ALICE, BOB, bearer, testApp, waitFor } from './helpers';
import {
  cacheSong,
  collectSse,
  FakeClock,
  jamSetup,
  VIDEO_A,
  VIDEO_B,
  VIDEO_C,
  type JamSetup,
  type SseEvent,
} from './jam-helpers';

const CAROL: User = { id: 'carol', displayName: 'Carol', key: 'carol-key-0123456789abcdefghij' };
const DAVE: User = { id: 'dave', displayName: 'Dave', key: 'dave-key-0123456789abcdefghij' };

type FetchRequest = Extract<JamFetchEvent, { type: 'jam_fetch' }>;
type Ping = Extract<JamFetchEvent, { type: 'jam_fetch_ping' }>;

const isPing = (event: SseEvent): event is Ping => event.type === 'jam_fetch_ping';
const isFetch = (event: SseEvent): event is FetchRequest => event.type === 'jam_fetch';

/** An app's presence stream, as the test sees it. */
interface Stream {
  events: SseEvent[];
  fetches(): FetchRequest[];
  pings(): Ping[];
  /** The latest ping's nonce (waits for one). */
  nonce(): Promise<string>;
  close(): void;
}

interface Context {
  app: FastifyInstance;
  s: JamSetup;
  baseUrl: string;
}

let ctx: Context | undefined;
const controllers = new Set<AbortController>();

afterEach(async () => {
  for (const controller of controllers) controller.abort();
  controllers.clear();
  await ctx?.app.close();
  await ctx?.s.cleanup();
  ctx = undefined;
});

/** Alice and Bob in "geral", Carol in "jogos", Dave nowhere; nobody has a fetch stream yet. */
async function listen(
  options: {
    people?: Record<RoomId, string[]>;
    pingMs?: number;
    persist?: boolean;
    fetchStartTimeoutMs?: number;
  } = {},
): Promise<Context> {
  const s = await jamSetup({
    people: options.people ?? { geral: ['alice', 'bob'], jogos: ['carol'] },
    persist: options.persist,
    service: {
      fetchPingMs: options.pingMs ?? 60_000,
      fetchStartTimeoutMs: options.fetchStartTimeoutMs,
    },
  });
  await s.service.start();
  const app = testApp({
    jam: s.service,
    presence: s.presence,
    users: new UserStore([ALICE, BOB, CAROL, DAVE]),
    heartbeatMs: 60_000,
  }).app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  ctx = { app, s, baseUrl: `http://127.0.0.1:${port}` };
  return ctx;
}

function current(): Context {
  if (!ctx) throw new Error('listen() first');
  return ctx;
}

/** Opens a presence stream and waits for its snapshots. */
async function openStream(user: User, query = 'jam=1&fetch=1'): Promise<Stream> {
  const controller = new AbortController();
  controllers.add(controller);
  const res = await fetch(`${current().baseUrl}/api/presence?${query}`, {
    headers: bearer(user),
    signal: controller.signal,
  });
  if (!res.body) throw new Error('missing body');
  const events = collectSse(res.body);
  await waitFor(() => events.length >= (query.includes('jam=1') ? 2 : 1));
  const pings = (): Ping[] => events.filter(isPing);
  return {
    events,
    fetches: () => events.filter(isFetch),
    pings,
    async nonce() {
      await waitFor(() => pings().length > 0);
      const ping = pings().at(-1);
      if (!ping) throw new Error('no ping');
      return ping.nonce;
    },
    close: () => controller.abort(),
  };
}

function pong(user: User, nonce: unknown) {
  return current().app.inject({
    method: 'POST',
    url: '/api/jam/fetch/pong',
    headers: bearer(user),
    payload: { nonce },
  });
}

/** A desktop app able to download, with a known round trip (measured with the fake clock). */
async function fetcher(user: User, rttMs?: number): Promise<Stream> {
  const stream = await openStream(user);
  if (rttMs !== undefined) {
    const nonce = await stream.nonce();
    current().s.clock.advance(rttMs);
    expect((await pong(user, nonce)).statusCode).toBe(204);
  }
  return stream;
}

function enqueue(user: User, videoId: string, room = 'geral') {
  return current().app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/jam/queue`,
    headers: bearer(user),
    payload: { videoId },
  });
}

/** Queues `videoId` as `user` (who cannot download) and returns the song. */
async function enqueued(user: User, videoId: string, room = 'geral'): Promise<JamItem> {
  const res = await enqueue(user, videoId, room);
  expect(res.statusCode).toBe(200);
  const body = res.json<JamEnqueueResponse>();
  expect(body.upload).toBe(false);
  return body.item;
}

function upload(user: User, itemId: string, room = 'geral') {
  return current().app.inject({
    method: 'PUT',
    url: `/api/rooms/${room}/jam/items/${itemId}/audio`,
    headers: { ...bearer(user), 'content-type': 'audio/webm' },
    payload: Buffer.alloc(2048, 3),
  });
}

function decline(
  user: User,
  itemId: string,
  payload: Record<string, unknown> = {},
  room = 'geral',
) {
  return current().app.inject({
    method: 'POST',
    url: `/api/rooms/${room}/jam/items/${itemId}/fetch/decline`,
    headers: bearer(user),
    payload,
  });
}

function errorOf(res: { json: <T>() => T }): string {
  return res.json<ApiErrorResponse>().error;
}

/** Waits for the app's next fetch request and returns it. */
async function nextFetch(stream: Stream, count = 1): Promise<FetchRequest> {
  await waitFor(() => stream.fetches().length >= count);
  const request = stream.fetches()[count - 1];
  if (!request) throw new Error('no fetch request');
  return request;
}

describe('GET /api/presence?jam=1&fetch=1', () => {
  it('registers the app, pings it right away and on every interval, and the pong records the round trip', async () => {
    const { s } = await listen({ pingMs: 40 });
    const bob = await openStream(BOB);
    expect(bob.events.map((event) => event.type)).toEqual([
      'snapshot',
      'jam_snapshot',
      'jam_fetch_ping',
    ]);
    expect(s.service.fetchers.hasUser('bob')).toBe(true);
    expect(s.service.fetchers.connections()).toEqual([
      { id: expect.any(String), userId: 'bob', rttMs: null },
    ]);
    const nonce = await bob.nonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    s.clock.advance(37);
    expect((await pong(BOB, nonce)).statusCode).toBe(204);
    expect(s.service.fetchers.connections()[0]?.rttMs).toBe(37);
    // Answered twice, or by someone else, or made up: ignored (nothing to tell the app).
    expect((await pong(BOB, nonce)).statusCode).toBe(204);
    expect((await pong(ALICE, await bob.nonce())).statusCode).toBe(204);
    expect((await pong(BOB, 'nope')).statusCode).toBe(204);
    expect(s.service.fetchers.connections()[0]?.rttMs).toBe(37);
    expect((await pong(BOB, undefined)).statusCode).toBe(400);
    // Pings keep coming; one left unanswered when the next goes out makes the round trip unknown.
    await waitFor(() => bob.pings().length >= 3);
    expect(new Set(bob.pings().map((ping) => ping.nonce)).size).toBe(bob.pings().length);
    expect(s.service.fetchers.connections()[0]?.rttMs).toBeNull();
    bob.close();
    await waitFor(() => s.service.fetchers.size === 0);
  });

  it('sends apps without fetch=1 the presence and jam events only', async () => {
    const { s } = await listen({ pingMs: 20 });
    const bob = await openStream(BOB, 'jam=1');
    const alice = await openStream(ALICE, 'fetch=1');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(bob.events.map((event) => event.type)).toEqual(['snapshot', 'jam_snapshot']);
    expect(alice.events.map((event) => event.type)).toEqual(['snapshot']);
    expect(s.service.fetchers.size).toBe(0);
  });
});

describe('POST /api/rooms/:room/jam/queue by a client that cannot download', () => {
  it('asks a desktop app, which then uploads the audio', async () => {
    const { s } = await listen();
    const bob = await fetcher(BOB);
    const res = await enqueue(ALICE, VIDEO_A);
    expect(res.statusCode).toBe(200);
    const body = res.json<JamEnqueueResponse>();
    expect(body).toMatchObject({
      item: { id: 'item-1', requestedBy: 'alice', status: 'downloading' },
      upload: false,
    });
    expect(await nextFetch(bob)).toEqual({ type: 'jam_fetch', room: 'geral', item: body.item });
    expect(s.service.snapshot().rooms.geral?.queue).toEqual([body.item]);
    expect(s.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ room: 'geral', itemId: 'item-1', fetcher: 'bob' }),
      'asked a desktop app to download a jam song',
    );

    const notAsked = await upload(CAROL, 'item-1');
    expect(notAsked.statusCode).toBe(403);
    expect(errorOf(notAsked)).toBe('not_requester');
    expect((await upload(BOB, 'item-1')).statusCode).toBe(204);
    await s.service.settled();
    expect(s.service.snapshot().rooms.geral?.current?.item).toMatchObject({
      id: 'item-1',
      status: 'ready',
    });
  });

  it('still takes the audio from the requester', async () => {
    await listen();
    const bob = await fetcher(BOB);
    const item = await enqueued(ALICE, VIDEO_A);
    await nextFetch(bob);
    expect((await upload(ALICE, item.id)).statusCode).toBe(204);
    const late = await upload(BOB, item.id);
    expect(late.statusCode).toBe(409);
    expect(errorOf(late)).toBe('already_uploaded');
  });

  it('lets a desktop app with a fetch stream download its own songs, as before', async () => {
    const { s } = await listen();
    const alice = await fetcher(ALICE);
    const bob = await fetcher(BOB);
    const res = await enqueue(ALICE, VIDEO_A);
    expect(res.statusCode).toBe(200);
    expect(res.json<JamEnqueueResponse>().upload).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alice.fetches()).toEqual([]);
    expect(bob.fetches()).toEqual([]);
    expect(s.service.snapshot().rooms.geral?.queue).toHaveLength(1);
  });

  it('refuses the song when no desktop app can download it', async () => {
    const { s } = await listen();
    const res = await enqueue(ALICE, VIDEO_A);
    expect(res.statusCode).toBe(503);
    expect(res.json<ApiErrorResponse>()).toEqual({
      error: 'no_downloader',
      message:
        'Ninguém com o Concord aberto no PC para baixar essa música agora. Tente de novo daqui a pouco.',
    });
    expect(s.service.snapshot().rooms).toEqual({});
    // An app of the requester's own cannot be asked (it would be able to download).
    await openStream(BOB, 'jam=1');
    expect((await enqueue(ALICE, VIDEO_A)).statusCode).toBe(503);
  });

  it('needs nobody for a cached song, nor for another copy of a song already awaited', async () => {
    const { s } = await listen();
    await cacheSong(s, VIDEO_A);
    const cached = await enqueue(ALICE, VIDEO_A);
    expect(cached.statusCode).toBe(200);
    expect(cached.json<JamEnqueueResponse>()).toMatchObject({
      item: { status: 'ready' },
      upload: false,
    });
    const bob = await fetcher(BOB);
    const item = await enqueued(ALICE, VIDEO_B);
    await nextFetch(bob);
    const copy = await enqueued(CAROL, VIDEO_B, 'jogos');
    expect(copy.id).not.toBe(item.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bob.fetches()).toHaveLength(1);
    expect(s.service.fetchers.size).toBe(1);
  });

  it('counts the web identity as being in the room', async () => {
    const { s } = await listen({ people: { geral: ['bob'] } });
    await fetcher(BOB);
    const outside = await enqueue(ALICE, VIDEO_A);
    expect(outside.statusCode).toBe(403);
    expect(errorOf(outside)).toBe('not_in_room');
    s.presence.join('geral', { id: webIdentity('alice'), name: 'Alice', joinedAt: 1 });
    const item = await enqueued(ALICE, VIDEO_A);
    expect(item.requestedBy).toBe('alice');
    const pause = await current().app.inject({
      method: 'POST',
      url: '/api/rooms/geral/jam/pause',
      headers: bearer(ALICE),
    });
    expect(pause.statusCode).toBe(204);
  });
});

describe('choosing the app to ask', () => {
  it('prefers an app whose person is in the room over a faster one elsewhere', async () => {
    await listen({ people: { geral: ['alice', 'carol'], jogos: ['bob'] } });
    const bob = await fetcher(BOB, 10);
    const carol = await fetcher(CAROL, 300);
    const item = await enqueued(ALICE, VIDEO_A);
    expect((await nextFetch(carol)).item).toEqual(item);
    expect(bob.fetches()).toEqual([]);
  });

  it('then the lowest round trip, unknown last', async () => {
    await listen({ people: { geral: ['alice'] } });
    const bob = await fetcher(BOB, 80);
    const carol = await fetcher(CAROL, 30);
    const dave = await fetcher(DAVE);
    const first = await enqueued(ALICE, VIDEO_A);
    expect((await nextFetch(carol)).item).toEqual(first);
    carol.close();
    await waitFor(() => !current().s.service.fetchers.hasUser('carol'));
    const second = await enqueued(ALICE, VIDEO_B);
    expect((await nextFetch(bob)).item).toEqual(second);
    expect(dave.fetches()).toEqual([]);
  });

  it('breaks ties by the fewest fetches in progress', async () => {
    const { s } = await listen({ people: { geral: ['alice'] } });
    const bob = await openStream(BOB);
    const carol = await openStream(CAROL);
    const nonces = [await bob.nonce(), await carol.nonce()];
    s.clock.advance(20);
    await pong(BOB, nonces[0]);
    await pong(CAROL, nonces[1]);
    const first = await enqueued(ALICE, VIDEO_A);
    expect((await nextFetch(bob)).item).toEqual(first);
    const second = await enqueued(ALICE, VIDEO_B);
    expect((await nextFetch(carol)).item).toEqual(second);
    const third = await enqueued(ALICE, VIDEO_C);
    expect((await nextFetch(bob, 2)).item).toEqual(third);
  });

  it('ranks unknown round trips last and never asks the excluded (JamFetchers.pick)', () => {
    const clock = new FakeClock();
    let next = 0;
    const fetchers = new JamFetchers({
      now: clock.now,
      pingMs: 60_000,
      newNonce: () => `n${++next}`,
    });
    const sent = new Map<string, JamFetchEvent[]>();
    const open = (userId: string): void => {
      sent.set(userId, []);
      fetchers.register({ userId, send: (event) => sent.get(userId)?.push(event) });
    };
    try {
      open('ana');
      open('bia');
      open('cid');
      expect(sent.get('ana')).toEqual([{ type: 'jam_fetch_ping', nonce: 'n1' }]);
      clock.advance(50);
      expect(fetchers.pong('n2', 'bia')).toBe(true);
      expect(fetchers.pong('n3', 'ana')).toBe(false); // someone else's ping
      clock.advance(10);
      expect(fetchers.pong('n3', 'cid')).toBe(true);
      const options = { exclude: new Set<string>(), inRoom: () => false, active: () => 0 };
      expect(fetchers.pick(options)?.userId).toBe('bia');
      expect(fetchers.pick({ ...options, exclude: new Set(['bia']) })?.userId).toBe('cid');
      expect(fetchers.pick({ ...options, exclude: new Set(['bia', 'cid']) })?.userId).toBe('ana');
      expect(fetchers.pick({ ...options, inRoom: (userId) => userId === 'ana' })?.userId).toBe(
        'ana',
      );
      expect(fetchers.pick({ ...options, exclude: new Set(['ana', 'bia', 'cid']) })).toBe(
        undefined,
      );
    } finally {
      fetchers.clear();
    }
    expect(fetchers.size).toBe(0);
  });
});

describe('replacing the app asked', () => {
  it('asks the next one when it declines; the first cannot decline twice', async () => {
    const { s } = await listen();
    const bob = await fetcher(BOB);
    const carol = await fetcher(CAROL);
    const item = await enqueued(ALICE, VIDEO_A);
    await nextFetch(bob);

    const notAsked = await decline(DAVE, item.id, { reason: 'not mine' });
    expect(notAsked.statusCode).toBe(403);
    expect(errorOf(notAsked)).toBe('not_requester');
    const longReason = await decline(BOB, item.id, { reason: 'x'.repeat(201) });
    expect(longReason.statusCode).toBe(400);
    expect(errorOf(longReason)).toBe('invalid_request');
    expect(carol.fetches()).toEqual([]);

    expect((await decline(BOB, item.id, { reason: 'yt-dlp failed' })).statusCode).toBe(204);
    expect(await nextFetch(carol)).toEqual({ type: 'jam_fetch', room: 'geral', item });
    expect(s.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: item.id, userId: 'bob', reason: 'yt-dlp failed' }),
      'a desktop app declined a jam fetch',
    );
    expect(s.service.snapshot().rooms.geral?.queue).toEqual([item]);

    const again = await decline(BOB, item.id);
    expect(again.statusCode).toBe(404);
    expect(errorOf(again)).toBe('item_not_found');
    const gone = await decline(CAROL, 'item-9');
    expect(gone.statusCode).toBe(404);
    // Carol was asked: her upload is taken, Bob's no longer.
    const stale = await upload(BOB, item.id);
    expect(stale.statusCode).toBe(403);
    expect((await upload(CAROL, item.id)).statusCode).toBe(204);
  });

  it('asks the next one when the first has not started by JAM_FETCH_START_TIMEOUT_MS', async () => {
    const { s } = await listen();
    const bob = await fetcher(BOB);
    const carol = await fetcher(CAROL);
    const item = await enqueued(ALICE, VIDEO_A);
    await nextFetch(bob);
    s.clock.advance(JAM_FETCH_START_TIMEOUT_MS - 1);
    s.service.sweep();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(carol.fetches()).toEqual([]);
    s.clock.advance(1);
    s.service.sweep();
    expect((await nextFetch(carol)).item).toEqual(item);
    expect(bob.fetches()).toHaveLength(1);
    expect(s.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ fetcher: 'carol', why: 'never started' }),
      'asked a desktop app to download a jam song',
    );
  });

  it('asks the next one when the first disconnected', async () => {
    const { s } = await listen();
    const bob = await fetcher(BOB);
    const carol = await fetcher(CAROL);
    const item = await enqueued(ALICE, VIDEO_A);
    await nextFetch(bob);
    bob.close();
    await waitFor(() => !s.service.fetchers.hasUser('bob'));
    s.service.sweep();
    expect((await nextFetch(carol)).item).toEqual(item);
  });

  it('leaves an upload already arriving alone until its app declines, then gives it up and asks the next app', async () => {
    // The start timeout is kept under the upload idle limit: the clock moves past it below.
    const { s } = await listen({ fetchStartTimeoutMs: 10_000 });
    const bob = await fetcher(BOB);
    const carol = await fetcher(CAROL);
    const item = await enqueued(ALICE, VIDEO_A);
    await nextFetch(bob);
    const body = new PassThrough();
    body.write(Buffer.alloc(1024, 1));
    const uploading = s.service.upload('bob', 'geral', item.id, body);
    s.clock.advance(10_000);
    s.service.sweep();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(carol.fetches()).toEqual([]);
    // Bob quits mid-upload (the desktop declines with 'app stopped' on logout/quit).
    expect((await decline(BOB, item.id, { reason: 'app stopped' })).statusCode).toBe(204);
    await expect(uploading).rejects.toMatchObject({ code: 'invalid_audio' });
    expect((await nextFetch(carol)).item).toEqual(item);
    expect(s.service.snapshot().rooms.geral?.queue).toEqual([item]);
    expect((await upload(CAROL, item.id)).statusCode).toBe(204);
    await s.service.settled();
    expect(s.service.snapshot().rooms.geral?.current?.item).toMatchObject({ id: item.id });
  });

  it('drops the song after JAM_FETCH_MAX_ASSIGNMENTS apps declined', async () => {
    const { s } = await listen();
    const apps = [BOB, CAROL, DAVE];
    expect(apps).toHaveLength(JAM_FETCH_MAX_ASSIGNMENTS);
    const streams = new Map<User, Stream>();
    for (const user of apps) streams.set(user, await fetcher(user));
    const item = await enqueued(ALICE, VIDEO_A);
    for (const user of apps) {
      const stream = streams.get(user);
      if (!stream) throw new Error('no stream');
      expect((await nextFetch(stream)).item).toEqual(item);
      expect((await decline(user, item.id)).statusCode).toBe(204);
    }
    expect(s.service.snapshot().rooms).toEqual({});
    expect(s.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: item.id, why: 'declined', assignments: 3 }),
      'no desktop app left to download a jam song, dropping it',
    );
    for (const stream of streams.values()) expect(stream.fetches()).toHaveLength(1);
  });

  it('drops the song when nobody is left to ask', async () => {
    const { s } = await listen();
    const bob = await fetcher(BOB);
    const item = await enqueued(ALICE, VIDEO_A);
    await nextFetch(bob);
    bob.close();
    await waitFor(() => s.service.fetchers.size === 0);
    s.service.sweep();
    expect(s.service.snapshot().rooms).toEqual({});
    expect(s.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: item.id, why: 'disconnected', assignments: 1 }),
      'no desktop app left to download a jam song, dropping it',
    );
  });

  it('hands a restored delegated song out again after a restart', async () => {
    const { s } = await listen({ persist: true });
    const bob = await fetcher(BOB);
    const item = await enqueued(ALICE, VIDEO_A);
    await nextFetch(bob);
    const service = await s.restart();
    await service.start();
    expect(service.snapshot().rooms.geral?.queue).toEqual([item]);
    const sent: JamFetchEvent[] = [];
    service.fetchers.register({ userId: 'carol', send: (event) => sent.push(event) });
    service.sweep();
    expect(sent.filter(isFetch)).toEqual([{ type: 'jam_fetch', room: 'geral', item }]);
    expect(service.fetchers.connections()).toHaveLength(1);
    service.fetchers.clear();
  });
});
