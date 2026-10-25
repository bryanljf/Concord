import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JAM_CACHE_TTL_MS,
  JAM_STREAM_START_BYTES,
  JAM_UPLOAD_TIMEOUT_MS,
  type JamEvent,
} from '@concord/shared';
import type { User } from '../src/auth';
import { JamBotError, type BotPlayRequest } from '../src/jam/bot-client';
import { JamAudioCache } from '../src/jam/cache';
import { JamError } from '../src/jam/errors';
import {
  JAM_BOT_LINGER_MS,
  JAM_CACHE_MAINTENANCE_MS,
  JAM_UPLOAD_IDLE_MS,
} from '../src/jam/service';
import { ALICE, bearer, testApp, waitFor } from './helpers';
import {
  audio,
  cacheSong,
  Gate,
  jamSetup,
  loggedText,
  track,
  VIDEO_A,
  VIDEO_B,
  VIDEO_C,
  type JamSetup,
  type JamSetupOptions,
} from './jam-helpers';

const KB = 1024;
const START = JAM_STREAM_START_BYTES;
const VIDEO_D = 'ddddddddddd';

let setup: JamSetup | undefined;
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  await setup?.cleanup();
  app = undefined;
  setup = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(options: JamSetupOptions = {}): Promise<JamSetup> {
  setup = await jamSetup(options);
  await setup.service.start();
  return setup;
}

/** The Jam behind a real HTTP server (streaming needs real sockets). */
async function listen(options: JamSetupOptions = {}): Promise<{ baseUrl: string; s: JamSetup }> {
  const s = await start(options);
  app = testApp({ jam: s.service, presence: s.presence }).app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, s };
}

/** A chunked PUT of the audio, sent bit by bit like the app streaming yt-dlp's output. */
function chunkedUpload(url: string, user: User = ALICE) {
  const req = request(url, {
    method: 'PUT',
    headers: { ...bearer(user), 'content-type': 'audio/webm', 'transfer-encoding': 'chunked' },
  });
  let answered = false;
  const response = new Promise<number>((resolve, reject) => {
    req.on('response', (res) => {
      answered = true;
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
  });
  response.catch(() => undefined);
  return {
    write: (bytes: number, fill = 7) =>
      new Promise<void>((resolve, reject) => {
        req.write(Buffer.alloc(bytes, fill), (err) => (err ? reject(err) : resolve()));
      }),
    end: (): Promise<number> => {
      req.end();
      return response;
    },
    abort: (): void => {
      req.destroy();
    },
    answered: (): boolean => answered,
  };
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

function lastPlay(s: JamSetup): { room: string; request: BotPlayRequest } {
  const play = s.bot.plays().at(-1);
  if (!play) throw new Error('the bot played nothing');
  return play;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts a streamed upload of `itemId` and waits until its song is ready (live). */
async function goLive(s: JamSetup, itemId: string, room = 'geral') {
  const body = new PassThrough();
  const uploading = s.service.upload('alice', room, itemId, body);
  uploading.catch(() => undefined);
  body.write(Buffer.alloc(START, 1));
  await waitFor(
    () =>
      s.bot.callsOf('probe').length > 0 &&
      s.service.snapshot().rooms[room] !== undefined &&
      isReady(s, room, itemId),
  );
  return { body, uploading };
}

function isReady(s: JamSetup, room: string, itemId: string): boolean {
  const state = s.service.snapshot().rooms[room];
  const item =
    state?.current?.item.id === itemId
      ? state.current.item
      : state?.queue.find((queued) => queued.id === itemId);
  return item?.status === 'ready';
}

describe('streamed uploads', () => {
  it('plays a slow chunked upload as it arrives, then stores it once whole', async () => {
    const { baseUrl, s } = await listen();
    const events: JamEvent[] = [];
    s.service.subscribe((event) => events.push(event));
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const put = chunkedUpload(`${baseUrl}/api/rooms/geral/jam/items/${item.id}/audio`);

    await put.write(100 * KB);
    await sleep(100);
    expect(s.bot.callsOf('probe')).toEqual([]);
    expect(s.service.snapshot().rooms.geral?.queue[0]?.status).toBe('downloading');

    await put.write(60 * KB);
    await waitFor(() => s.bot.plays().length === 1);
    const temp = lastPlay(s).request.file;
    expect(temp.startsWith(join(s.cacheDir, '.tmp-'))).toBe(true);
    expect(lastPlay(s)).toEqual({
      room: 'geral',
      request: {
        livekitUrl: 'ws://127.0.0.1:7880',
        token: `token-geral-${s.clock.time}`,
        itemId: item.id,
        file: temp,
        offsetMs: 0,
        paused: false,
        growing: true,
      },
    });
    // The header was checked once JAM_STREAM_START_BYTES were on disk.
    expect(s.bot.callsOf('probe')).toEqual([{ method: 'probe', file: temp, partial: true }]);
    expect(s.bot.probedSizes[0]).toBeGreaterThanOrEqual(START);
    expect(events.at(-1)).toMatchObject({
      type: 'jam_updated',
      state: {
        current: { item: { id: item.id, status: 'ready', track: { durationMs: 200_000 } } },
      },
    });
    expect(put.answered()).toBe(false);

    await put.write(200 * KB);
    expect(await put.end()).toBe(204);
    expect(s.bot.callsOf('probe').at(-1)).toEqual({ method: 'probe', file: temp, partial: false });
    expect(s.bot.callsOf('complete')).toEqual([{ method: 'complete', file: temp }]);
    expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_A}.webm`]);
    expect((await stat(join(s.cacheDir, `${VIDEO_A}.webm`))).size).toBe(360 * KB);
    // The exact duration, once the file is whole.
    expect(s.service.snapshot().rooms.geral?.current?.item.track.durationMs).toBe(199_500);
    expect(s.bot.plays()).toHaveLength(1);

    // Later plays of the song use the stored file.
    const again = await s.service.enqueue('bob', 'geral', VIDEO_A);
    expect(again.upload).toBe(false);
    await s.service.skip('bob', 'geral', item.id);
    expect(lastPlay(s).request).toMatchObject({
      itemId: again.item.id,
      file: join(s.cacheDir, `${VIDEO_A}.webm`),
      growing: false,
    });
  });

  it('drops the song everywhere when the upload breaks off after it started playing', async () => {
    const { baseUrl, s } = await listen({ people: { geral: ['alice', 'bob'], jogos: ['carol'] } });
    await cacheSong(s, VIDEO_B);
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const put = chunkedUpload(`${baseUrl}/api/rooms/geral/jam/items/${item.id}/audio`);
    await put.write(START + 10 * KB);
    await waitFor(() => s.bot.plays().length === 1);
    const temp = lastPlay(s).request.file;

    // Meanwhile: a song after it, and a copy of it in another room (no upload: it streams in).
    const next = await s.service.enqueue('bob', 'geral', VIDEO_B);
    const copy = await s.service.enqueue('carol', 'jogos', VIDEO_A);
    expect(copy).toMatchObject({ upload: false, item: { status: 'ready' } });
    await s.service.settled();
    expect(lastPlay(s)).toMatchObject({
      room: 'jogos',
      request: { itemId: copy.item.id, file: temp, growing: true },
    });

    put.abort();
    await waitFor(() => s.bot.callsOf('failed').length === 1);
    expect(s.bot.callsOf('failed')).toEqual([{ method: 'failed', file: temp }]);
    // The bot also reports `error` for the rooms that played it: nothing more moves.
    await sleep(50);
    await s.service.settled();
    const { rooms } = s.service.snapshot();
    expect(rooms.geral).toMatchObject({ current: { item: { id: next.item.id } }, queue: [] });
    expect(rooms.jogos).toBeUndefined();
    expect(
      s.bot
        .plays()
        .filter((play) => play.room === 'geral')
        .map((play) => play.request.itemId),
    ).toEqual([item.id, next.item.id]);
    expect(lastPlay(s).request.file).toBe(join(s.cacheDir, `${VIDEO_B}.webm`));
    await waitFor(() => !existsSync(temp));
    expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_B}.webm`]);
    expect(loggedText(s.log)).not.toContain('token-');
  });

  it('drops a playing song whose upload goes over the limit', async () => {
    const s = await start({ service: { uploadMaxBytes: START + 64 * KB } });
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const { body, uploading } = await goLive(s, item.id);
    await waitFor(() => s.bot.plays().length === 1);
    const temp = lastPlay(s).request.file;
    body.write(Buffer.alloc(65 * KB, 2));
    expect(await rejection(uploading)).toBe('payload_too_large');
    expect(s.bot.callsOf('failed')).toEqual([{ method: 'failed', file: temp }]);
    await s.service.settled();
    expect(s.service.snapshot().rooms).toEqual({});
    expect(await readdir(s.cacheDir)).toEqual([]);
  });

  it('drops a playing song whose whole file the bot rejects', async () => {
    const s = await start();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const { body, uploading } = await goLive(s, item.id);
    s.bot.probeError = new JamBotError(422, 'invalid_audio', 'corrupt cluster');
    body.end(Buffer.alloc(10 * KB, 3));
    expect(await rejection(uploading)).toBe('invalid_audio');
    expect(s.bot.callsOf('failed')).toHaveLength(1);
    expect(s.bot.callsOf('complete')).toEqual([]);
    await s.service.settled();
    expect(s.service.snapshot().rooms).toEqual({});
    expect(await readdir(s.cacheDir)).toEqual([]);
  });

  it('rejects a bad header right away, while the app is still sending', async () => {
    const s = await start();
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    const copy = await s.service.enqueue('bob', 'geral', VIDEO_A);
    s.bot.partialProbeError = new JamBotError(422, 'invalid_audio', 'not webm');
    const body = new PassThrough();
    const uploading = s.service.upload('alice', 'geral', 'item-1', body);
    body.write(Buffer.alloc(START, 1));
    expect(await rejection(uploading)).toBe('invalid_audio');
    expect(body.writableEnded).toBe(false);
    expect(s.bot.plays()).toEqual([]);
    expect(s.bot.callsOf('failed')).toEqual([]); // it never played
    // Every song waiting for it leaves.
    expect(copy.item.status).toBe('downloading');
    expect(s.service.snapshot().rooms).toEqual({});
    expect(await readdir(s.cacheDir)).toEqual([]);
  });

  it('checks the whole file instead when the bot cannot check the first bytes', async () => {
    const s = await start();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    s.bot.partialProbeError = new JamBotError(0, 'unreachable', 'ECONNREFUSED');
    const body = new PassThrough();
    const uploading = s.service.upload('alice', 'geral', item.id, body);
    body.write(Buffer.alloc(START + KB, 1));
    await waitFor(() => s.bot.callsOf('probe').length === 1);
    await sleep(30);
    expect(s.service.snapshot().rooms.geral?.queue[0]?.status).toBe('downloading');
    body.end(Buffer.alloc(KB, 2));
    await uploading;
    await s.service.settled();
    expect(s.service.snapshot().rooms.geral?.current?.item).toMatchObject({
      id: item.id,
      status: 'ready',
      track: { durationMs: 199_500 },
    });
    expect(lastPlay(s).request).toMatchObject({
      file: join(s.cacheDir, `${VIDEO_A}.webm`),
      growing: false,
    });
    expect(s.bot.callsOf('complete')).toEqual([]);
    expect(s.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: VIDEO_A }),
      'could not check a jam upload as it arrived',
    );
  });

  it('renames the file only once the bot has opened it', async () => {
    const s = await start();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    s.bot.playGate = new Gate();
    const { body, uploading } = await goLive(s, item.id);
    await waitFor(() => s.bot.plays().length === 1);
    const temp = lastPlay(s).request.file;
    body.end(Buffer.alloc(10 * KB, 2));
    await waitFor(() => s.bot.callsOf('probe').length === 2); // the whole file, checked
    await sleep(30);
    expect(existsSync(temp)).toBe(true); // the PUT naming it is still in flight
    s.bot.playGate.open();
    await uploading;
    await s.service.settled();
    // The bot opened the temporary file (it was there), then it became the song's.
    expect(s.bot.state.get('geral')).toMatchObject({ itemId: item.id, state: 'playing' });
    expect(existsSync(temp)).toBe(false);
    expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_A}.webm`]);
  });

  it('has a song starting during the rename wait for it, then play the stored file', async () => {
    const s = await start({ people: { geral: ['alice'], jogos: ['carol'] } });
    const gate = new Gate();
    const commit = JamAudioCache.prototype.commit;
    vi.spyOn(JamAudioCache.prototype, 'commit').mockImplementation(async function (
      this: JamAudioCache,
      temp: string,
      videoId: string,
    ) {
      await gate.promise;
      return commit.call(this, temp, videoId);
    });
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const { body, uploading } = await goLive(s, item.id);
    await waitFor(() => s.bot.plays().length === 1);
    body.end();
    await waitFor(() => s.bot.callsOf('probe').length === 2);
    await sleep(20); // renaming now (held)
    const copy = await s.service.enqueue('carol', 'jogos', VIDEO_A);
    expect(copy.upload).toBe(false);
    await sleep(30);
    expect(s.bot.plays()).toHaveLength(1); // the copy waits for the rename
    gate.open();
    await uploading;
    await s.service.settled();
    expect(lastPlay(s)).toMatchObject({
      room: 'jogos',
      request: {
        itemId: copy.item.id,
        file: join(s.cacheDir, `${VIDEO_A}.webm`),
        growing: false,
      },
    });
  });

  it('gives up an upload that stalls, before or after its song is ready', async () => {
    const s = await start();
    const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const second = await s.service.enqueue('alice', 'geral', VIDEO_B);
    const live = await goLive(s, first.item.id);
    const slow = new PassThrough();
    const uploading = s.service.upload('alice', 'geral', second.item.id, slow);
    slow.write(Buffer.alloc(KB, 1));
    await sleep(30);
    s.clock.advance(JAM_UPLOAD_IDLE_MS - 1);
    s.service.sweep();
    s.clock.advance(1);
    live.body.write(Buffer.alloc(KB, 1)); // this one is still sending
    await sleep(30);
    s.service.sweep();
    expect(await rejection(uploading)).toBe('invalid_audio');
    s.clock.advance(JAM_UPLOAD_IDLE_MS);
    s.service.sweep();
    expect(await rejection(live.uploading)).toBe('invalid_audio');
    expect(s.bot.callsOf('failed')).toHaveLength(1); // only the live one played
    await s.service.settled();
    expect(s.service.snapshot().rooms).toEqual({});
    expect(await readdir(s.cacheDir)).toEqual([]);
  });

  it('drops, after a restart, the ready songs whose upload was still streaming', async () => {
    const s = await start({
      persist: true,
      tracks: [track(VIDEO_A), track(VIDEO_B), track(VIDEO_C), track(VIDEO_D)],
    });
    await cacheSong(s, VIDEO_B);
    await cacheSong(s, VIDEO_C);
    const streaming = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const { body, uploading } = await goLive(s, streaming.item.id);
    const kept = await s.service.enqueue('alice', 'geral', VIDEO_B);
    const gone = await s.service.enqueue('alice', 'geral', VIDEO_C);
    const waiting = await s.service.enqueue('alice', 'geral', VIDEO_D);
    await s.service.settled();
    await rm(join(s.cacheDir, `${VIDEO_C}.webm`)); // lost too (deleted by hand, say)
    expect(s.bot.state.get('geral')?.itemId).toBe(streaming.item.id);

    const restarted = await s.restart();
    await restarted.start();
    expect(restarted.snapshot().rooms.geral).toMatchObject({
      current: { item: { id: kept.item.id } },
      queue: [{ id: waiting.item.id, status: 'downloading' }],
    });
    expect(gone.item.id).not.toBe(kept.item.id);
    expect(s.log.warn).toHaveBeenCalledWith(
      { videoIds: [VIDEO_A, VIDEO_C] },
      'dropping restored jam songs whose audio is not in the cache',
    );
    // The bot still plays the dropped song: catching up moves it on.
    s.bot.calls.length = 0;
    await s.bot.reconnect();
    await restarted.settled();
    expect(s.bot.plays()).toEqual([
      {
        room: 'geral',
        request: expect.objectContaining({
          itemId: kept.item.id,
          file: join(s.cacheDir, `${VIDEO_B}.webm`),
          growing: false,
        }),
      },
    ]);
    body.destroy();
    expect(await rejection(uploading)).toBe('invalid_audio');
  });
});

describe('the bot in the room', () => {
  it('joins an idle room as soon as a song to download is queued', async () => {
    const s = await start();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    await s.service.settled();
    expect(s.bot.callsOf('connect')).toEqual([
      {
        method: 'connect',
        room: 'geral',
        request: { livekitUrl: 'ws://127.0.0.1:7880', token: `token-geral-${s.clock.time}` },
      },
    ]);
    await s.service.enqueue('bob', 'geral', VIDEO_B); // it is there already
    await s.service.settled();
    expect(s.bot.callsOf('connect')).toHaveLength(1);

    await s.service.upload('alice', 'geral', item.id, audio());
    await s.service.settled();
    expect(s.bot.plays()).toHaveLength(1);
    expect(s.bot.callsOf('leave')).toEqual([]);
  });

  it('does not join early when a song plays already', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A);
    await s.service.enqueue('alice', 'geral', VIDEO_A); // plays right away
    await s.service.enqueue('alice', 'geral', VIDEO_B); // to download, but A plays
    await s.service.settled();
    expect(s.bot.callsOf('connect')).toEqual([]);
    expect(s.bot.plays()).toHaveLength(1);
  });

  it('retries joining early with backoff, logging once, and stops once useless', async () => {
    const s = await start({ service: { retryDelay: () => 20 } });
    s.bot.connectErrors.push(
      new JamBotError(0, 'unreachable', 'ECONNREFUSED'),
      new JamBotError(502, 'livekit_error', 'down'),
    );
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    await waitFor(() => s.bot.state.get('geral')?.state === 'idle');
    expect(s.bot.callsOf('connect')).toHaveLength(3);
    const warned = s.log.warn.mock.calls.filter(
      ([, msg]) => msg === 'could not bring the jam bot into the room early',
    );
    expect(warned).toHaveLength(1);
    expect(s.log.info).toHaveBeenCalledWith(
      { room: 'geral', failures: 2 },
      'jam bot joined the room',
    );
  });

  it('stops trying to join early once the queue empties', async () => {
    const s = await start({ service: { retryDelay: () => 150 } });
    s.bot.connectErrors.push(new JamBotError(0, 'unreachable', 'ECONNREFUSED'));
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    await waitFor(() => s.bot.callsOf('connect').length === 1);
    await s.service.remove('alice', 'geral', item.id);
    await sleep(250);
    expect(s.bot.callsOf('connect')).toHaveLength(1);
    expect(s.bot.state.has('geral')).toBe(false);
  });

  it('stays in a room whose songs still download when catching up with the bot', async () => {
    const s = await start();
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    await s.service.settled();
    expect(s.bot.state.get('geral')?.state).toBe('idle');
    s.bot.calls.length = 0;
    await s.bot.reconnect();
    await s.service.settled();
    expect(s.bot.calls).toEqual([{ method: 'rooms' }]);

    // The upload never comes: the jam empties, the bot lingers, then leaves.
    s.clock.advance(JAM_UPLOAD_TIMEOUT_MS);
    s.service.sweep();
    await s.service.settled();
    expect(s.service.snapshot().rooms).toEqual({});
    expect(s.bot.callsOf('leave')).toEqual([]);
    s.clock.advance(JAM_BOT_LINGER_MS);
    s.service.sweep();
    await s.service.settled();
    expect(s.bot.callsOf('leave')).toEqual([{ method: 'leave', room: 'geral' }]);
  });

  it('stays two minutes after the jam ends, so a new song starts without joining again', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A);
    await cacheSong(s, VIDEO_B);
    const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
    await s.service.settled();
    s.bot.emit({ type: 'ended', room: 'geral', itemId: first.item.id });
    await s.service.settled();
    s.clock.advance(JAM_BOT_LINGER_MS - 1000);
    s.service.sweep();
    await s.service.settled();
    expect(s.bot.callsOf('leave')).toEqual([]);

    const second = await s.service.enqueue('bob', 'geral', VIDEO_B);
    await s.service.settled();
    expect(lastPlay(s).request.itemId).toBe(second.item.id);
    s.clock.advance(JAM_BOT_LINGER_MS);
    s.service.sweep();
    await s.service.settled();
    expect(s.bot.callsOf('leave')).toEqual([]);
    expect(s.bot.callsOf('connect')).toEqual([]);
  });

  it('answers an enqueue without waiting for the bot', async () => {
    const s = await start();
    await cacheSong(s, VIDEO_A);
    s.bot.playGate = new Gate();
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    expect(s.service.snapshot().rooms.geral?.current?.item.id).toBe(item.id);
    await waitFor(() => s.bot.plays().length === 1);
    expect(s.bot.state.get('geral')).toBeUndefined(); // still joining
    s.bot.playGate.open();
    await s.service.settled();
    expect(s.bot.state.get('geral')).toMatchObject({ itemId: item.id, state: 'playing' });
  });

  it('never logs the tokens it hands the bot', async () => {
    const s = await start({ service: { retryDelay: () => 10 } });
    await cacheSong(s, VIDEO_B);
    s.bot.connectErrors.push(new JamBotError(502, 'livekit_error', 'down'));
    await s.service.enqueue('alice', 'geral', VIDEO_A);
    await waitFor(() => s.bot.callsOf('connect').length === 2);
    s.bot.unreachable = true;
    await s.service.enqueue('alice', 'geral', VIDEO_B);
    await s.service.settled();
    expect(s.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ room: 'geral' }),
      'could not update the jam bot, retrying',
    );
    const tokens = [...s.bot.callsOf('connect'), ...s.bot.callsOf('play')].map((call) =>
      'request' in call ? call.request.token : '',
    );
    expect(tokens.length).toBeGreaterThan(2);
    const text = loggedText(s.log);
    for (const token of tokens) expect(text).not.toContain(token);
  });
});

describe('search and the cache', () => {
  it('says which results need no download, streaming ones included', async () => {
    const s = await start({
      tracks: [
        track(VIDEO_A, { title: 'Song one' }),
        track(VIDEO_B, { title: 'Song two' }),
        track(VIDEO_C, { title: 'Song three' }),
      ],
    });
    await cacheSong(s, VIDEO_C);
    expect((await s.service.search('song')).cached).toEqual([VIDEO_C]);
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const { body, uploading } = await goLive(s, item.id);
    expect((await s.service.search('song')).cached).toEqual([VIDEO_A, VIDEO_C]);
    body.end();
    await uploading;
    expect((await s.service.search('song')).cached).toEqual([VIDEO_A, VIDEO_C]);
  });

  it('trims the cache every 10 minutes, keeping uploads in progress', async () => {
    expect(JAM_CACHE_MAINTENANCE_MS).toBe(10 * 60_000);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const maintain = vi.spyOn(JamAudioCache.prototype, 'maintain');
    const s = await start({ cacheTtlMs: JAM_CACHE_TTL_MS });
    await waitFor(() => maintain.mock.calls.length === 1); // at start
    const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
    const { body, uploading } = await goLive(s, item.id);
    vi.advanceTimersByTime(JAM_CACHE_MAINTENANCE_MS - 1);
    await sleep(30);
    expect(maintain).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await waitFor(() => maintain.mock.calls.length === 2);
    const [keep, temps] = maintain.mock.calls[1] ?? [];
    expect(keep).toEqual(new Set([VIDEO_A]));
    expect([...(temps ?? [])]).toEqual([lastPlay(s).request.file]);
    body.end();
    await uploading;
    await waitFor(() => maintain.mock.calls.length === 3); // and after every upload
  });
});
