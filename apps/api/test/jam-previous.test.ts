import { readFile, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JAM_CACHE_TTL_MS,
  JAM_STREAM_START_BYTES,
  type ApiErrorResponse,
  type JamState,
} from '@concord/shared';
import { JamError } from '../src/jam/errors';
import { JAM_BOT_LINGER_MS } from '../src/jam/service';
import { ALICE, BOB, bearer, testApp, waitFor } from './helpers';
import {
  cacheSong,
  jamSetup,
  VIDEO_A,
  VIDEO_B,
  VIDEO_C,
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

/** A, B and C cached and queued in geral (item-1, item-2, item-3); A plays. */
async function threeSongs(options: JamSetupOptions = {}): Promise<JamSetup> {
  const s = await start(options);
  for (const videoId of [VIDEO_A, VIDEO_B, VIDEO_C]) {
    await cacheSong(s, videoId);
    await s.service.enqueue('alice', 'geral', videoId);
  }
  await s.service.settled();
  return s;
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

function geral(s: JamSetup): JamState | undefined {
  return s.service.snapshot().rooms.geral;
}

function historyIds(s: JamSetup): string[] | undefined {
  return geral(s)?.history?.map((item) => item.id);
}

describe('the history of a jam', () => {
  it('remembers songs that ended, were skipped or removed while playing, not failed ones', async () => {
    const s = await threeSongs();
    await cacheSong(s, VIDEO_A);
    await s.service.enqueue('bob', 'geral', VIDEO_A); // item-4
    s.bot.emit({ type: 'ended', room: 'geral', itemId: 'item-1' });
    await s.service.settled();
    await s.service.skip('bob', 'geral', 'item-2');
    s.bot.emit({ type: 'error', room: 'geral', itemId: 'item-3', message: 'boom' });
    await s.service.settled();
    expect(historyIds(s)).toEqual(['item-2', 'item-1']);
    await s.service.remove('bob', 'geral', 'item-4');
    // Nothing plays nor is queued: the room stays with its history while the bot lingers.
    expect(geral(s)).toMatchObject({ current: null, queue: [] });
    expect(historyIds(s)).toEqual(['item-4', 'item-2', 'item-1']);
  });

  it('is in every jam state sent, empty included', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A);
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    expect(geral(s)?.history).toEqual([]);
  });

  it('keeps the files of its songs in the cache, which count as used when they enter it', async () => {
    const s = await threeSongs({ cacheTtlMs: JAM_CACHE_TTL_MS });
    const file = join(s.cacheDir, `${VIDEO_A}.webm`);
    const old = new Date(Date.now() - JAM_CACHE_TTL_MS - 60_000);
    await utimes(file, old, old);
    await s.service.skip('bob', 'geral', 'item-1');
    await s.service.settled();
    expect(Date.now() - (await stat(file)).mtimeMs).toBeLessThan(60_000);
    // Old again, but in the history: kept.
    await utimes(file, old, old);
    await s.service.maintainCache();
    expect((await stat(file)).isFile()).toBe(true);
    // The jam ends and the bot's linger runs out: nothing keeps it anymore.
    await s.service.skip('bob', 'geral', 'item-2');
    await s.service.skip('bob', 'geral', 'item-3');
    await s.service.settled();
    s.clock.advance(JAM_BOT_LINGER_MS);
    s.service.sweep();
    await s.service.settled();
    expect(geral(s)).toBeUndefined();
    await utimes(file, old, old);
    await s.service.maintainCache();
    await expect(stat(file)).rejects.toThrow();
  });

  it('survives a restart', async () => {
    const s = await threeSongs({ persist: true });
    await s.service.skip('bob', 'geral', 'item-1');
    await s.service.skip('bob', 'geral', 'item-2');
    const before = s.service.snapshot().rooms;
    const restarted = await s.restart();
    const saved = JSON.parse(await readFile(s.stateFile, 'utf8')) as { rooms: JamState[] };
    expect(saved.rooms[0]?.history?.map((item) => item.id)).toEqual(['item-2', 'item-1']);
    await restarted.start();
    expect(restarted.snapshot().rooms).toEqual(before);
    await restarted.previous('bob', 'geral', 'item-3');
    expect(restarted.snapshot().rooms.geral?.current?.item.id).toBe('item-2');
  });

  it('drops, after a restart, songs of the history whose audio is gone', async () => {
    const s = await threeSongs({ persist: true });
    await s.service.skip('bob', 'geral', 'item-1');
    await s.service.skip('bob', 'geral', 'item-2');
    const restarted = await s.restart();
    await rm(join(s.cacheDir, `${VIDEO_A}.webm`));
    await restarted.start();
    expect(restarted.snapshot().rooms.geral?.history?.map((item) => item.id)).toEqual(['item-2']);
  });
});

describe('JamService.previous', () => {
  it('plays the previous song from the start; skipping returns to the one that was playing', async () => {
    const s = await threeSongs();
    s.clock.advance(30_000);
    await s.service.skip('bob', 'geral', 'item-1');
    s.clock.advance(10_000);
    await s.service.previous('bob', 'geral', 'item-2');
    expect(geral(s)).toMatchObject({
      current: { item: { id: 'item-1' }, positionMs: 0, at: s.clock.time, paused: false },
      queue: [{ id: 'item-2' }, { id: 'item-3' }],
      history: [],
    });
    expect(s.bot.plays().at(-1)?.request).toMatchObject({
      itemId: 'item-1',
      file: join(s.cacheDir, `${VIDEO_A}.webm`),
      offsetMs: 0,
      paused: false,
      growing: false,
    });
    await s.service.skip('bob', 'geral', 'item-1');
    expect(geral(s)?.current?.item.id).toBe('item-2');
    expect(s.bot.plays().at(-1)?.request).toMatchObject({ itemId: 'item-2', offsetMs: 0 });
  });

  it('plays the previous song when nothing plays', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A);
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    await s.service.enqueue('alice', 'geral', VIDEO_B); // still downloading
    await s.service.settled();
    s.bot.emit({ type: 'ended', room: 'geral', itemId: 'item-1' });
    await s.service.settled();
    expect(geral(s)).toMatchObject({ current: null, history: [{ id: 'item-1' }] });
    await s.service.previous('alice', 'geral', null);
    expect(geral(s)?.current?.item.id).toBe('item-1');
    expect(s.bot.plays().at(-1)?.request.itemId).toBe('item-1');
  });

  it('answers stale, no_previous and not_in_room', async () => {
    const s = await threeSongs();
    expect(await rejection(s.service.previous('bob', 'geral', 'item-1'))).toBe('no_previous');
    await s.service.skip('bob', 'geral', 'item-1');
    expect(await rejection(s.service.previous('bob', 'geral', 'item-1'))).toBe('stale');
    expect(await rejection(s.service.previous('bob', 'geral', null))).toBe('stale');
    expect(await rejection(s.service.previous('carol', 'geral', 'item-2'))).toBe('not_in_room');
    // Two quick presses go back one song.
    await s.service.previous('bob', 'geral', 'item-2');
    expect(await rejection(s.service.previous('alice', 'geral', 'item-2'))).toBe('stale');
  });

  it('answers previous_unavailable once its audio left the cache, and forgets it', async () => {
    const s = await threeSongs();
    await s.service.skip('bob', 'geral', 'item-1');
    await s.service.skip('bob', 'geral', 'item-2');
    await rm(join(s.cacheDir, `${VIDEO_B}.webm`));
    const plays = s.bot.plays().length;
    expect(await rejection(s.service.previous('bob', 'geral', 'item-3'))).toBe(
      'previous_unavailable',
    );
    expect(geral(s)).toMatchObject({
      current: { item: { id: 'item-3' } },
      history: [{ id: 'item-1' }],
    });
    expect(s.bot.plays()).toHaveLength(plays);
    await s.service.previous('bob', 'geral', 'item-3');
    expect(geral(s)?.current?.item.id).toBe('item-1');
  });

  it('plays a song whose upload still streams from the growing file', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_B);
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const body = new PassThrough();
    const uploading = s.service.upload('alice', 'geral', item.id, body);
    body.write(Buffer.alloc(JAM_STREAM_START_BYTES, 1));
    await waitFor(() => s.bot.plays().length === 1);
    const temp = s.bot.plays()[0]?.request.file;
    await s.service.enqueue('alice', 'geral', VIDEO_B);
    await s.service.skip('bob', 'geral', item.id);
    await s.service.previous('bob', 'geral', 'item-2');
    expect(s.bot.plays().at(-1)?.request).toMatchObject({
      itemId: item.id,
      file: temp,
      growing: true,
    });
    body.end();
    await uploading;
  });

  it('never offers a song whose streamed upload failed', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_B);
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const body = new PassThrough();
    const uploading = s.service.upload('alice', 'geral', item.id, body);
    uploading.catch(() => undefined);
    body.write(Buffer.alloc(JAM_STREAM_START_BYTES, 1));
    await waitFor(() => s.bot.plays().length === 1);
    await s.service.enqueue('alice', 'geral', VIDEO_B);
    await s.service.skip('bob', 'geral', item.id);
    expect(historyIds(s)).toEqual([item.id]);
    body.destroy(); // the app went away
    expect(await rejection(uploading)).toBe('invalid_audio');
    await s.service.settled();
    expect(historyIds(s)).toEqual([]);
    expect(await rejection(s.service.previous('bob', 'geral', 'item-2'))).toBe('no_previous');
  });
});

describe('POST /api/rooms/:room/jam/previous', () => {
  async function previousApp() {
    const s = await threeSongs();
    app = testApp({ jam: s.service, presence: s.presence }).app;
    const previous = (payload: unknown, user = BOB, room = 'geral') =>
      (app as FastifyInstance).inject({
        method: 'POST',
        url: `/api/rooms/${room}/jam/previous`,
        headers: bearer(user),
        payload: payload as Record<string, unknown>,
      });
    return { s, previous };
  }

  it('plays the previous song', async () => {
    const { s, previous } = await previousApp();
    await s.service.skip('bob', 'geral', 'item-1');
    const res = await previous({ itemId: 'item-2' });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(geral(s)?.current?.item.id).toBe('item-1');
  });

  it('answers no_previous, stale, previous_unavailable and not_in_room', async () => {
    const { s, previous } = await previousApp();
    const none = await previous({ itemId: 'item-1' });
    expect(none.statusCode).toBe(409);
    expect(none.json<ApiErrorResponse>().error).toBe('no_previous');
    await s.service.skip('bob', 'geral', 'item-1');
    const stale = await previous({ itemId: null });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ApiErrorResponse>().error).toBe('stale');
    await rm(join(s.cacheDir, `${VIDEO_A}.webm`));
    const gone = await previous({ itemId: 'item-2' });
    expect(gone.statusCode).toBe(410);
    expect(gone.json<ApiErrorResponse>()).toEqual({
      error: 'previous_unavailable',
      message: 'A música anterior não está mais no servidor.',
    });
    s.presence.leave('geral', 'bob');
    const outside = await previous({ itemId: 'item-2' });
    expect(outside.statusCode).toBe(403);
    expect(outside.json<ApiErrorResponse>().error).toBe('not_in_room');
    const unknown = await previous({ itemId: 'item-2' }, ALICE, 'sala-x');
    expect(unknown.json<ApiErrorResponse>().error).toBe('unknown_room');
  });

  it.each([
    ['no itemId', {}],
    ['a long itemId', { itemId: 'x'.repeat(65) }],
  ])('rejects %s', async (_label, payload) => {
    const { previous } = await previousApp();
    const res = await previous(payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorResponse>().error).toBe('invalid_request');
  });

  it('is rate limited like skip', async () => {
    const { previous } = await previousApp();
    for (let i = 0; i < 60; i += 1) await previous({ itemId: 'nope' });
    expect((await previous({ itemId: 'nope' })).statusCode).toBe(429);
  });
});
