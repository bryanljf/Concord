import { readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JAM_MAX_DURATION_MS,
  JAM_QUEUE_MAX,
  type ApiErrorResponse,
  type JamEnqueueResponse,
  type JamSearchResponse,
  type JamSnapshot,
} from '@concord/shared';
import { JamBotError } from '../src/jam/bot-client';
import { ALICE, BOB, bearer, testApp } from './helpers';
import {
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

async function jamApp(options: JamSetupOptions = {}) {
  setup = await jamSetup(options);
  await setup.service.start();
  app = testApp({ jam: setup.service, presence: setup.presence }).app;
  return { app, s: setup };
}

afterEach(async () => {
  await app?.close();
  await setup?.cleanup();
  app = undefined;
  setup = undefined;
});

function enqueue(target: FastifyInstance, videoId: unknown, user = ALICE, room = 'geral') {
  return target.inject({
    method: 'POST',
    url: `/api/rooms/${room}/jam/queue`,
    headers: bearer(user),
    payload: { videoId },
  });
}

function upload(
  target: FastifyInstance,
  itemId: string,
  payload: Buffer | Readable = Buffer.alloc(2048, 3),
  options: { user?: typeof ALICE; contentType?: string | null; room?: string } = {},
) {
  const headers: Record<string, string> = { ...bearer(options.user ?? ALICE) };
  if (options.contentType !== null) headers['content-type'] = options.contentType ?? 'audio/webm';
  return target.inject({
    method: 'PUT',
    url: `/api/rooms/${options.room ?? 'geral'}/jam/items/${itemId}/audio`,
    headers,
    payload,
  });
}

function errorOf(res: { json: <T>() => T }): string {
  return res.json<ApiErrorResponse>().error;
}

describe('jam routes', () => {
  it('need the session', async () => {
    const { app } = await jamApp();
    const requests = [
      { method: 'GET', url: '/api/jam' },
      { method: 'GET', url: '/api/jam/search?q=x' },
      { method: 'POST', url: '/api/rooms/geral/jam/queue', payload: { videoId: VIDEO_A } },
      { method: 'POST', url: '/api/rooms/geral/jam/pause' },
      { method: 'POST', url: '/api/rooms/geral/jam/resume' },
      { method: 'POST', url: '/api/rooms/geral/jam/skip', payload: { itemId: 'x' } },
      { method: 'DELETE', url: '/api/rooms/geral/jam/items/x' },
      {
        method: 'PUT',
        url: '/api/rooms/geral/jam/items/x/audio',
        headers: { 'content-type': 'audio/webm' },
        payload: Buffer.alloc(10),
      },
    ] as const;
    for (const request of requests) {
      const res = await app.inject(request);
      expect(res.statusCode, request.url).toBe(401);
      expect(errorOf(res)).toBe('unauthorized');
    }
  });

  it('GET /api/jam answers the snapshot', async () => {
    const { app, s } = await jamApp();
    const res = await app.inject({ method: 'GET', url: '/api/jam', headers: bearer(BOB) });
    expect(res.statusCode).toBe(200);
    expect(res.json<JamSnapshot>()).toEqual({
      available: true,
      rooms: {},
      serverTime: s.clock.time,
    });
  });

  describe('GET /api/jam/search', () => {
    it('searches YouTube Music', async () => {
      const { app } = await jamApp({ tracks: [track(VIDEO_A, { title: 'Get Lucky' })] });
      const res = await app.inject({
        method: 'GET',
        url: '/api/jam/search?q=%20get%20lucky%20',
        headers: bearer(ALICE),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<JamSearchResponse>()).toEqual({
        results: [track(VIDEO_A, { title: 'Get Lucky' })],
        cached: [],
      });
    });

    it('tells which results the server already has', async () => {
      const { app, s } = await jamApp({
        tracks: [
          track(VIDEO_A, { title: 'Song one' }),
          track(VIDEO_B, { title: 'Song two' }),
          track(VIDEO_C, { title: 'Song three' }),
        ],
      });
      await cacheSong(s, VIDEO_B);
      await cacheSong(s, VIDEO_C, 0); // empty: not a song
      const res = await app.inject({
        method: 'GET',
        url: '/api/jam/search?q=song',
        headers: bearer(ALICE),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<JamSearchResponse>();
      expect(body.results.map((result) => result.videoId)).toEqual([VIDEO_A, VIDEO_B, VIDEO_C]);
      expect(body.cached).toEqual([VIDEO_B]);
    });

    it('rejects empty and long queries, and reports YouTube failures', async () => {
      const { app, s } = await jamApp();
      for (const url of [
        '/api/jam/search',
        '/api/jam/search?q=%20',
        `/api/jam/search?q=${'a'.repeat(101)}`,
      ]) {
        const res = await app.inject({ method: 'GET', url, headers: bearer(ALICE) });
        expect(res.statusCode, url).toBe(400);
        expect(res.json<ApiErrorResponse>()).toEqual({
          error: 'invalid_query',
          message: 'A busca deve ter de 1 a 100 caracteres.',
        });
      }
      s.youtube.failing = true;
      const res = await app.inject({
        method: 'GET',
        url: '/api/jam/search?q=x',
        headers: bearer(ALICE),
      });
      expect(res.statusCode).toBe(502);
      expect(errorOf(res)).toBe('search_failed');
    });

    it('works without a bot, and is rate limited', async () => {
      const { app } = await jamApp({ withBot: false });
      for (let i = 0; i < 30; i += 1) {
        const res = await app.inject({
          method: 'GET',
          url: '/api/jam/search?q=song',
          headers: bearer(ALICE),
        });
        expect(res.statusCode).toBe(200);
      }
      const limited = await app.inject({
        method: 'GET',
        url: '/api/jam/search?q=song',
        headers: bearer(ALICE),
      });
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited)).toBe('rate_limited');
    });
  });

  describe('POST /api/rooms/:room/jam/queue', () => {
    it('queues a song and tells the app whether to upload it', async () => {
      const { app, s } = await jamApp();
      const res = await enqueue(app, VIDEO_A);
      expect(res.statusCode).toBe(200);
      expect(res.json<JamEnqueueResponse>()).toEqual({
        item: {
          id: 'item-1',
          track: track(VIDEO_A),
          requestedBy: 'alice',
          addedAt: s.clock.time,
          status: 'downloading',
        },
        upload: true,
      });
      const again = await enqueue(app, VIDEO_A, BOB);
      expect(again.json<JamEnqueueResponse>()).toMatchObject({
        item: { id: 'item-2', requestedBy: 'bob', status: 'downloading' },
        upload: false,
      });
    });

    it.each<[string, () => Promise<{ statusCode: number; json: <T>() => T }>, number, string]>([
      [
        'an unknown room',
        () => enqueue(app as FastifyInstance, VIDEO_A, ALICE, 'sala-x'),
        400,
        'unknown_room',
      ],
      [
        'someone outside the room',
        () => enqueue(app as FastifyInstance, VIDEO_A, ALICE, 'jogos'),
        403,
        'not_in_room',
      ],
      ['no videoId', () => enqueue(app as FastifyInstance, undefined), 400, 'invalid_video'],
      [
        'a malformed videoId',
        () => enqueue(app as FastifyInstance, 'https://youtu.be/x'),
        400,
        'invalid_video',
      ],
      [
        'an unknown song',
        () => enqueue(app as FastifyInstance, 'zzzzzzzzzzz'),
        404,
        'track_not_found',
      ],
    ])('rejects %s', async (_label, send, status, code) => {
      await jamApp();
      const res = await send();
      expect(res.statusCode).toBe(status);
      expect(errorOf(res)).toBe(code);
    });

    it('rejects songs that are too long and a full queue', async () => {
      const { app, s } = await jamApp({
        tracks: [track(VIDEO_A), track(VIDEO_B, { durationMs: JAM_MAX_DURATION_MS + 1000 })],
      });
      const long = await enqueue(app, VIDEO_B);
      expect(long.statusCode).toBe(422);
      expect(errorOf(long)).toBe('too_long');
      for (let i = 0; i < JAM_QUEUE_MAX; i += 1) {
        await s.service.enqueue('alice', 'geral', VIDEO_A);
      }
      const full = await enqueue(app, VIDEO_A);
      expect(full.statusCode).toBe(409);
      expect(errorOf(full)).toBe('queue_full');
    });

    it('answers jam_unavailable without a bot', async () => {
      const { app } = await jamApp({ withBot: false });
      const res = await enqueue(app, VIDEO_A);
      expect(res.statusCode).toBe(503);
      expect(res.json<ApiErrorResponse>()).toEqual({
        error: 'jam_unavailable',
        message: 'A Jam não está disponível neste servidor agora.',
      });
      const snapshot = await app.inject({ method: 'GET', url: '/api/jam', headers: bearer(ALICE) });
      expect(snapshot.json<JamSnapshot>().available).toBe(false);
    });
  });

  describe('PUT /api/rooms/:room/jam/items/:itemId/audio', () => {
    it('stores the audio and starts playing it', async () => {
      const { app, s } = await jamApp();
      await enqueue(app, VIDEO_A);
      const res = await upload(app, 'item-1', Buffer.alloc(5000, 9), {
        contentType: 'audio/webm; codecs=opus',
      });
      expect(res.statusCode).toBe(204);
      await s.service.settled();
      expect(res.body).toBe('');
      expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_A}.webm`]);
      const snapshot = await app.inject({ method: 'GET', url: '/api/jam', headers: bearer(BOB) });
      expect(snapshot.json<JamSnapshot>().rooms.geral?.current?.item).toMatchObject({
        id: 'item-1',
        status: 'ready',
      });
      expect(s.bot.plays()).toHaveLength(1);
    });

    it('takes the upload from the requester even after they left the room', async () => {
      const { app, s } = await jamApp();
      await enqueue(app, VIDEO_A);
      s.presence.leave('geral', 'alice');
      expect((await upload(app, 'item-1')).statusCode).toBe(204);
    });

    it('accepts only the requester, once, for a song still waiting', async () => {
      const { app } = await jamApp();
      await enqueue(app, VIDEO_A);
      const notYours = await upload(app, 'item-1', undefined, { user: BOB });
      expect(notYours.statusCode).toBe(403);
      expect(errorOf(notYours)).toBe('not_requester');
      const missing = await upload(app, 'item-9');
      expect(missing.statusCode).toBe(404);
      expect(errorOf(missing)).toBe('item_not_found');
      expect((await upload(app, 'item-1')).statusCode).toBe(204);
      const twice = await upload(app, 'item-1');
      expect(twice.statusCode).toBe(409);
      expect(errorOf(twice)).toBe('already_uploaded');
    });

    it.each<[string, string | null]>([
      ['octet-stream', 'application/octet-stream'],
      ['JSON', 'application/json'],
      ['another audio type', 'audio/mpeg'],
      ['no content type', null],
    ])('answers 415 to %s and keeps the song waiting', async (_label, contentType) => {
      const { app, s } = await jamApp();
      await enqueue(app, VIDEO_A);
      const payload = contentType === 'application/json' ? Buffer.from('{}') : Buffer.alloc(10);
      const res = await upload(app, 'item-1', payload, { contentType });
      expect(res.statusCode).toBe(415);
      expect(errorOf(res)).toBe('unsupported_media_type');
      expect(s.service.snapshot().rooms.geral?.queue).toHaveLength(1);
    });

    it('answers 413 over the limit, announced or streamed, and drops the song', async () => {
      const { app, s } = await jamApp({ service: { uploadMaxBytes: 4096 } });
      await enqueue(app, VIDEO_A);
      await enqueue(app, VIDEO_B);
      const announced = await upload(app, 'item-1', Buffer.alloc(4097));
      expect(announced.statusCode).toBe(413);
      expect(errorOf(announced)).toBe('payload_too_large');
      const streamed = await upload(
        app,
        'item-2',
        Readable.from([Buffer.alloc(3000), Buffer.alloc(3000)]),
      );
      expect(streamed.statusCode).toBe(413);
      expect(s.service.snapshot().rooms).toEqual({});
      expect(await readdir(s.cacheDir)).toEqual([]);
    });

    it('answers invalid_audio when the bot rejects the file', async () => {
      const { app, s } = await jamApp();
      await enqueue(app, VIDEO_A);
      s.bot.probeError = new JamBotError(422, 'invalid_audio', 'no opus');
      const res = await upload(app, 'item-1');
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toBe('invalid_audio');
      expect(await readdir(s.cacheDir)).toEqual([]);
    });

    it('is rate limited', async () => {
      const { app } = await jamApp();
      for (let i = 0; i < 20; i += 1) await upload(app, 'nope');
      const res = await upload(app, 'nope');
      expect(res.statusCode).toBe(429);
    });
  });

  describe('playback controls', () => {
    async function playing() {
      const ctx = await jamApp();
      for (const videoId of [VIDEO_A, VIDEO_B, VIDEO_C]) {
        await ctx.s.service.enqueue('alice', 'geral', videoId);
        await ctx.s.service.upload(
          'alice',
          'geral',
          `item-${[VIDEO_A, VIDEO_B, VIDEO_C].indexOf(videoId) + 1}`,
          Readable.from([Buffer.alloc(100)]),
        );
      }
      return ctx;
    }

    it('pauses and resumes for everyone', async () => {
      const { app, s } = await playing();
      const pause = await app.inject({
        method: 'POST',
        url: '/api/rooms/geral/jam/pause',
        headers: bearer(BOB),
      });
      expect(pause.statusCode).toBe(204);
      expect(s.service.snapshot().rooms.geral?.current).toMatchObject({
        paused: true,
        pausedBy: 'bob',
      });
      expect(s.bot.callsOf('pause')).toHaveLength(1);
      const resume = await app.inject({
        method: 'POST',
        url: '/api/rooms/geral/jam/resume',
        headers: bearer(ALICE),
      });
      expect(resume.statusCode).toBe(204);
      expect(s.service.snapshot().rooms.geral?.current).toMatchObject({
        paused: false,
        pausedBy: null,
      });
    });

    it('skips only the song still playing', async () => {
      const { app, s } = await playing();
      const skip = (itemId: unknown) =>
        app.inject({
          method: 'POST',
          url: '/api/rooms/geral/jam/skip',
          headers: bearer(BOB),
          payload: { itemId },
        });
      const stale = await skip('item-2');
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale)).toBe('stale');
      expect((await skip('item-1')).statusCode).toBe(204);
      expect(s.service.snapshot().rooms.geral?.current?.item.id).toBe('item-2');
      expect((await skip('item-1')).statusCode).toBe(409);
    });

    it('removes upcoming songs, and the current one skips', async () => {
      const { app, s } = await playing();
      const remove = (itemId: string) =>
        app.inject({
          method: 'DELETE',
          url: `/api/rooms/geral/jam/items/${itemId}`,
          headers: bearer(BOB),
        });
      expect((await remove('item-3')).statusCode).toBe(204);
      expect((await remove('item-1')).statusCode).toBe(204);
      expect(s.service.snapshot().rooms.geral).toMatchObject({
        current: { item: { id: 'item-2' } },
        queue: [],
      });
      const missing = await remove('item-3');
      expect(missing.statusCode).toBe(404);
      expect(errorOf(missing)).toBe('item_not_found');
      expect((await remove('item-2')).statusCode).toBe(204);
      expect(s.service.snapshot().rooms).toEqual({});
      // Silenced; it leaves only after lingering a while (a new song would start right away).
      expect(s.bot.callsOf('pause')).toEqual([{ method: 'pause', room: 'geral' }]);
      expect(s.bot.callsOf('leave')).toHaveLength(0);
    });

    it('need the caller in the room', async () => {
      const { app, s } = await playing();
      s.presence.leave('geral', 'bob');
      const res = await app.inject({
        method: 'POST',
        url: '/api/rooms/geral/jam/pause',
        headers: bearer(BOB),
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res)).toBe('not_in_room');
    });
  });
});
