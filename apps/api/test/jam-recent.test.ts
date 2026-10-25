import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JAM_CACHE_TTL_MS,
  JAM_STREAM_START_BYTES,
  type ApiErrorResponse,
  type JamRecentResponse,
} from '@concord/shared';
import { ALICE, bearer, testApp, waitFor } from './helpers';
import {
  audio,
  cacheSong,
  jamSetup,
  track,
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

async function recentIds(s: JamSetup): Promise<string[]> {
  return (await s.service.recent()).tracks.map((song) => song.videoId);
}

describe('JamService.recent', () => {
  it('is empty at first, and without a bot', async () => {
    const s = await start();
    expect(await s.service.recent()).toEqual({ tracks: [] });
    await s.cleanup();
    const without = await start({ withBot: false });
    await cacheSong(without, VIDEO_A);
    expect(await without.service.recent()).toEqual({ tracks: [] });
  });

  it('lists only songs that started playing and are still here, the last to start first', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A);
    await cacheSong(s, VIDEO_B);
    const first = await s.service.enqueue('alice', 'geral', VIDEO_A); // plays
    const startedA = s.clock.time;
    s.clock.advance(1000);
    await s.service.enqueue('alice', 'geral', VIDEO_B); // only queued
    await s.service.enqueue('alice', 'geral', VIDEO_C); // to download
    await s.service.settled();
    expect((await s.service.recent()).tracks).toEqual([{ ...track(VIDEO_A), usedAt: startedA }]);

    s.clock.advance(1000);
    await s.service.skip('bob', 'geral', first.item.id); // B starts
    const startedB = s.clock.time;
    expect((await s.service.recent()).tracks).toEqual([
      { ...track(VIDEO_B), usedAt: startedB },
      { ...track(VIDEO_A), usedAt: startedA },
    ]);

    s.clock.advance(1000);
    await s.service.previous('bob', 'geral', 'item-2'); // A again
    expect((await s.service.recent()).tracks.map((song) => [song.videoId, song.usedAt])).toEqual([
      [VIDEO_A, s.clock.time],
      [VIDEO_B, startedB],
    ]);
  });

  it('lists a song that played as it streamed once its upload is stored, exact duration included', async () => {
    const s = await start();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const body = new PassThrough();
    const uploading = s.service.upload('alice', 'geral', item.id, body);
    body.write(Buffer.alloc(JAM_STREAM_START_BYTES, 1));
    await waitFor(() => s.bot.plays().length === 1);
    const startedAt = s.clock.time;
    expect(await recentIds(s)).toEqual([]); // still being uploaded
    s.clock.advance(5000);
    body.end(Buffer.alloc(1024, 2));
    await uploading;
    expect((await s.service.recent()).tracks).toEqual([
      { ...track(VIDEO_A), durationMs: 199_500, usedAt: startedAt },
    ]);
  });

  it('never lists a song uploaded but not played yet', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A);
    await s.service.enqueue('alice', 'geral', VIDEO_A); // plays
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_B);
    await s.service.upload('alice', 'geral', item.id, audio());
    await s.service.settled();
    expect(await recentIds(s)).toEqual([VIDEO_A]);
  });

  it('drops songs the cache lets go (TTL or size), and keeps the list across restarts', async () => {
    const s = await start({ cacheTtlMs: JAM_CACHE_TTL_MS });
    await cacheSong(s, VIDEO_A);
    await cacheSong(s, VIDEO_B);
    const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
    await s.service.enqueue('alice', 'geral', VIDEO_B);
    await s.service.settled();
    s.clock.advance(1000);
    await s.service.skip('bob', 'geral', first.item.id);
    s.bot.emit({ type: 'ended', room: 'geral', itemId: 'item-2' }); // the jam is over
    await s.service.settled();
    expect(await recentIds(s)).toEqual([VIDEO_B, VIDEO_A]);

    const restarted = await s.restart();
    await restarted.start();
    expect((await restarted.recent()).tracks.map((song) => song.videoId)).toEqual([
      VIDEO_B,
      VIDEO_A,
    ]);

    const old = new Date(Date.now() - JAM_CACHE_TTL_MS - 60_000);
    await utimes(join(s.cacheDir, `${VIDEO_A}.webm`), old, old);
    await restarted.maintainCache();
    expect((await restarted.recent()).tracks.map((song) => song.videoId)).toEqual([VIDEO_B]);
  });

  it('lists a song stored before song infos existed once it plays again', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A); // audio only, as an older api left it
    expect(await recentIds(s)).toEqual([]);
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    await s.service.settled();
    expect(await recentIds(s)).toEqual([VIDEO_A]);
  });
});

describe('GET /api/jam/recent', () => {
  it('answers the recent songs', async () => {
    const s = await start();
    app = testApp({ jam: s.service, presence: s.presence }).app;
    await cacheSong(s, VIDEO_A);
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    await s.service.settled();
    const res = await app.inject({ method: 'GET', url: '/api/jam/recent', headers: bearer(ALICE) });
    expect(res.statusCode).toBe(200);
    expect(res.json<JamRecentResponse>()).toEqual({
      tracks: [{ ...track(VIDEO_A), usedAt: s.clock.time }],
    });
  });

  it('needs the session and is rate limited like search', async () => {
    const s = await start();
    app = testApp({ jam: s.service, presence: s.presence }).app;
    const anonymous = await app.inject({ method: 'GET', url: '/api/jam/recent' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<ApiErrorResponse>().error).toBe('unauthorized');
    for (let i = 0; i < 29; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/jam/recent',
        headers: bearer(ALICE),
      });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'GET',
      url: '/api/jam/recent',
      headers: bearer(ALICE),
    });
    expect(limited.statusCode).toBe(429);
  });
});
