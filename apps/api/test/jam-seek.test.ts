import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JAM_STREAM_START_BYTES,
  type ApiErrorResponse,
  type JamEvent,
  type JamNowPlaying,
} from '@concord/shared';
import type { BotPlayRequest } from '../src/jam/bot-client';
import { JamError } from '../src/jam/errors';
import { ALICE, BOB, bearer, testApp, waitFor } from './helpers';
import {
  cacheSong,
  Gate,
  jamSetup,
  VIDEO_A,
  VIDEO_B,
  type JamSetup,
  type JamSetupOptions,
} from './jam-helpers';

let setup: JamSetup | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await setup?.cleanup();
  app = undefined;
  setup = undefined;
});

async function start(options: JamSetupOptions = {}): Promise<JamSetup> {
  setup = await jamSetup(options);
  await setup.service.start();
  return setup;
}

/** A started jam playing VIDEO_A (cached) in geral, with VIDEO_B queued after it. */
async function playing(options: JamSetupOptions = {}) {
  const s = await start(options);
  await cacheSong(s, VIDEO_A);
  await cacheSong(s, VIDEO_B);
  const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
  const next = await s.service.enqueue('alice', 'geral', VIDEO_B);
  await s.service.settled();
  return { s, item, next: next.item };
}

async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof JamError) return err.code;
    throw err;
  }
  return undefined;
}

function lastPlay(s: JamSetup): BotPlayRequest {
  const play = s.bot.plays().at(-1);
  if (!play) throw new Error('the bot played nothing');
  return play.request;
}

function current(s: JamSetup): JamNowPlaying | null | undefined {
  return s.service.snapshot().rooms.geral?.current;
}

describe('JamService.seek', () => {
  it('moves the jam at once, has the bot play the file from there and adopts where it landed', async () => {
    const { s, item } = await playing();
    s.bot.landing = (offsetMs) => offsetMs - 7; // the packet holding the offset
    s.clock.advance(10_000);
    const events: JamEvent[] = [];
    s.service.subscribe((event) => events.push(event));
    await s.service.seek('bob', 'geral', item.id, 61_234);
    expect(s.bot.plays()).toHaveLength(2);
    expect(lastPlay(s)).toEqual({
      livekitUrl: 'ws://127.0.0.1:7880',
      token: `token-geral-${s.clock.time}`,
      itemId: item.id,
      file: join(s.cacheDir, `${VIDEO_A}.webm`),
      offsetMs: 61_234,
      paused: false,
      growing: false,
    });
    // Optimistic first, then where the bot really is.
    expect(
      events.map((event) => (event.type === 'jam_updated' ? event.state.current?.positionMs : 0)),
    ).toEqual([61_234, 61_227]);
    expect(current(s)).toMatchObject({ positionMs: 61_227, at: s.clock.time, paused: false });
  });

  it('keeps a paused song paused at the new position', async () => {
    const { s, item } = await playing();
    s.clock.advance(10_000);
    await s.service.pause('bob', 'geral');
    await s.service.seek('alice', 'geral', item.id, 150_000);
    expect(lastPlay(s)).toMatchObject({ offsetMs: 150_000, paused: true, growing: false });
    expect(s.bot.state.get('geral')).toMatchObject({ state: 'paused', positionMs: 150_000 });
    s.clock.advance(20_000);
    expect(current(s)).toMatchObject({ positionMs: 150_000, paused: true, pausedBy: 'bob' });
    await s.service.resume('alice', 'geral');
    expect(s.bot.state.get('geral')?.state).toBe('playing');
    expect(current(s)).toMatchObject({ positionMs: 150_000, paused: false });
  });

  it('clamps past the end: the bot has nothing left there, so the next song plays', async () => {
    const { s, item, next } = await playing();
    await s.service.seek('bob', 'geral', item.id, 999_999);
    expect(s.bot.plays()[1]?.request).toMatchObject({ itemId: item.id, offsetMs: 200_000 });
    expect(lastPlay(s)).toMatchObject({ itemId: next.id, offsetMs: 0 });
    expect(s.service.snapshot().rooms.geral).toMatchObject({
      current: { item: { id: next.id } },
      history: [{ id: item.id }],
    });
  });

  it('does nothing when the song is already there', async () => {
    const { s, item } = await playing();
    s.clock.advance(10_000);
    const events: JamEvent[] = [];
    s.service.subscribe((event) => events.push(event));
    await s.service.seek('bob', 'geral', item.id, 10_100);
    expect(s.bot.plays()).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('seeks only the song still playing, from inside the room', async () => {
    const { s, item, next } = await playing();
    expect(await rejection(s.service.seek('bob', 'geral', next.id, 1000))).toBe('stale');
    expect(await rejection(s.service.seek('carol', 'geral', item.id, 1000))).toBe('not_in_room');
    expect(await rejection(s.service.seek('bob', 'sala-x', item.id, 1000))).toBe('unknown_room');
    expect(s.bot.plays()).toHaveLength(1);
  });

  it('sends only the latest of quick seeks, never adopting an outdated answer', async () => {
    const { s, item } = await playing();
    s.bot.playGate = new Gate();
    const events: JamEvent[] = [];
    s.service.subscribe((event) => events.push(event));
    const first = s.service.seek('bob', 'geral', item.id, 60_000);
    await waitFor(() => s.bot.plays().length === 2);
    const second = s.service.seek('alice', 'geral', item.id, 120_000);
    s.bot.playGate.open();
    await Promise.all([first, second]);
    await s.service.settled();
    expect(s.bot.plays().map((play) => play.request.offsetMs)).toEqual([0, 60_000, 120_000]);
    const positions = events.map((event) =>
      event.type === 'jam_updated' ? event.state.current?.positionMs : undefined,
    );
    expect(positions).toEqual([60_000, 120_000, 120_000]);
    expect(current(s)?.positionMs).toBe(120_000);
  });

  it('keeps the seek while the bot is down and sends it once the bot is back', async () => {
    const { s, item } = await playing();
    s.bot.unreachable = true;
    await s.service.seek('bob', 'geral', item.id, 90_000);
    expect(current(s)).toMatchObject({ positionMs: 90_000, at: s.clock.time });
    expect(s.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ room: 'geral' }),
      'could not update the jam bot, retrying',
    );
    // Back: it still says it plays from the start; the seek wins over that.
    s.bot.unreachable = false;
    s.clock.advance(3_000);
    await s.bot.reconnect();
    await s.service.settled();
    expect(lastPlay(s)).toMatchObject({ itemId: item.id, offsetMs: 93_000, paused: false });
    expect(current(s)).toMatchObject({ positionMs: 93_000, at: s.clock.time });
    expect(s.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ room: 'geral' }),
      'jam bot caught up',
    );
  });

  it('plays the growing upload from there while it streams, the stored file once whole', async () => {
    const s = await start();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const body = new PassThrough();
    const uploading = s.service.upload('alice', 'geral', item.id, body);
    body.write(Buffer.alloc(JAM_STREAM_START_BYTES, 1));
    await waitFor(() => s.bot.plays().length === 1);
    const temp = lastPlay(s).file;
    expect(temp.startsWith(join(s.cacheDir, '.tmp-'))).toBe(true);

    // Past what arrived so far: the bot waits there for the rest.
    await s.service.seek('bob', 'geral', item.id, 150_000);
    expect(lastPlay(s)).toMatchObject({ file: temp, growing: true, offsetMs: 150_000 });

    body.end(Buffer.alloc(1024, 2));
    await uploading;
    await s.service.seek('bob', 'geral', item.id, 30_000);
    expect(lastPlay(s)).toMatchObject({
      file: join(s.cacheDir, `${VIDEO_A}.webm`),
      growing: false,
      offsetMs: 30_000,
    });
  });
});

describe('POST /api/rooms/:room/jam/seek', () => {
  async function seekApp() {
    const ctx = await playing();
    app = testApp({ jam: ctx.s.service, presence: ctx.s.presence }).app;
    const seek = (payload: unknown, user = BOB, room = 'geral') =>
      (app as FastifyInstance).inject({
        method: 'POST',
        url: `/api/rooms/${room}/jam/seek`,
        headers: bearer(user),
        payload: payload as Record<string, unknown>,
      });
    return { ...ctx, seek };
  }

  it('moves the song for everyone', async () => {
    const { s, item, seek } = await seekApp();
    const res = await seek({ itemId: item.id, positionMs: 45_000 });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(current(s)?.positionMs).toBe(45_000);
    expect(lastPlay(s).offsetMs).toBe(45_000);
  });

  it('answers stale, not_in_room and unknown_room', async () => {
    const { s, item, next, seek } = await seekApp();
    const stale = await seek({ itemId: next.id, positionMs: 1000 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ApiErrorResponse>().error).toBe('stale');
    s.presence.leave('geral', 'bob');
    const outside = await seek({ itemId: item.id, positionMs: 1000 });
    expect(outside.statusCode).toBe(403);
    expect(outside.json<ApiErrorResponse>().error).toBe('not_in_room');
    const unknown = await seek({ itemId: item.id, positionMs: 1000 }, ALICE, 'sala-x');
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json<ApiErrorResponse>().error).toBe('unknown_room');
  });

  it.each([
    ['no itemId', { positionMs: 1000 }],
    ['no position', { itemId: 'item-1' }],
    ['a negative position', { itemId: 'item-1', positionMs: -1 }],
    ['a fractional position', { itemId: 'item-1', positionMs: 1.5 }],
    ['a position that is not a number', { itemId: 'item-1', positionMs: 'soon' }],
    ['a long itemId', { itemId: 'x'.repeat(65), positionMs: 1000 }],
  ])('rejects %s', async (_label, payload) => {
    const { s, seek } = await seekApp();
    const res = await seek(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorResponse>().error).toBe('invalid_request');
    expect(s.bot.plays()).toHaveLength(1);
  });

  it('is rate limited like pause and resume', async () => {
    const { item, seek } = await seekApp();
    for (let i = 0; i < 60; i += 1) await seek({ itemId: item.id, positionMs: 1000 * i });
    const res = await seek({ itemId: item.id, positionMs: 0 });
    expect(res.statusCode).toBe(429);
  });
});
