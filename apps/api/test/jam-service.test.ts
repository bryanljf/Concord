import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile, mkdir, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  JAM_CACHE_TTL_MS,
  JAM_MAX_DURATION_MS,
  JAM_UPLOAD_TIMEOUT_MS,
  type JamEvent,
} from '@concord/shared';
import { JamBotError } from '../src/jam/bot-client';
import { JamError } from '../src/jam/errors';
import { JAM_BOT_LINGER_MS, JAM_EMPTY_ROOM_MS } from '../src/jam/service';
import { waitFor } from './helpers';
import {
  audio,
  cacheSong,
  jamSetup,
  track,
  VIDEO_A,
  VIDEO_B,
  VIDEO_C,
  type JamSetup,
} from './jam-helpers';

let setup: JamSetup | undefined;

async function start(options: Parameters<typeof jamSetup>[0] = {}): Promise<JamSetup> {
  setup = await jamSetup(options);
  await setup.service.start();
  return setup;
}

afterEach(async () => {
  await setup?.cleanup();
  setup = undefined;
});

async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof JamError) return err.code;
    throw err;
  }
  return undefined;
}

function record(s: JamSetup): JamEvent[] {
  const events: JamEvent[] = [];
  s.service.subscribe((event) => events.push(event));
  return events;
}

describe('JamService', () => {
  describe('playback', () => {
    it('plays a cached song right away, with a fresh token and the absolute cache path', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      const { item, upload } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      expect(upload).toBe(false);
      await s.service.settled();
      expect(s.bot.plays()).toEqual([
        {
          room: 'geral',
          request: {
            livekitUrl: 'ws://127.0.0.1:7880',
            token: `token-geral-${s.clock.time}`,
            itemId: item.id,
            file: join(s.cacheDir, `${VIDEO_A}.webm`),
            offsetMs: 0,
            paused: false,
            growing: false,
          },
        },
      ]);
      expect(s.service.snapshot().rooms.geral?.current?.item.id).toBe(item.id);
    });

    it('moves on when the bot finishes a song, and leaves a while after nothing is left', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      await cacheSong(s, VIDEO_B);
      const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
      const second = await s.service.enqueue('bob', 'geral', VIDEO_B);
      await s.service.settled();
      expect(s.bot.plays()).toHaveLength(1);

      s.bot.emit({ type: 'ended', room: 'geral', itemId: first.item.id });
      await s.service.settled();
      expect(s.bot.plays().map((play) => play.request.itemId)).toEqual([
        first.item.id,
        second.item.id,
      ]);

      s.bot.emit({ type: 'error', room: 'geral', itemId: second.item.id, message: 'boom' });
      await s.service.settled();
      expect(s.service.snapshot().rooms).toEqual({});
      // It stays, silent, so a song added soon starts without joining LiveKit again.
      s.clock.advance(JAM_BOT_LINGER_MS - 1);
      s.service.sweep();
      await s.service.settled();
      expect(s.bot.callsOf('leave')).toEqual([]);
      s.clock.advance(1);
      s.service.sweep();
      await s.service.settled();
      expect(s.bot.callsOf('leave')).toEqual([{ method: 'leave', room: 'geral' }]);
      expect(s.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'boom' }),
        'the jam bot gave up on a song',
      );
    });

    it('stays in the room, silent, while the next song is still downloading', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.settled();
      await s.service.enqueue('bob', 'geral', VIDEO_B); // downloading
      s.bot.emit({ type: 'ended', room: 'geral', itemId: first.item.id });
      await s.service.settled();
      expect(s.bot.callsOf('leave')).toEqual([]);
      expect(s.bot.callsOf('connect')).toEqual([]); // it is there already
      expect(s.bot.plays()).toHaveLength(1);
    });

    it("pauses and resumes the bot, keeping the bot's exact position", async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.settled();
      s.clock.advance(30_000);
      const status = s.bot.state.get('geral');
      if (status) status.positionMs = 29_870; // what the bot really sent
      await s.service.pause('bob', 'geral');
      expect(s.bot.callsOf('pause')).toHaveLength(1);
      expect(s.service.snapshot().rooms.geral?.current).toMatchObject({
        item: { id: item.id },
        positionMs: 29_870,
        at: s.clock.time,
        paused: true,
        pausedBy: 'bob',
      });

      s.clock.advance(60_000);
      await s.service.resume('alice', 'geral');
      expect(s.bot.callsOf('resume')).toHaveLength(1);
      expect(s.service.snapshot().rooms.geral?.current).toMatchObject({
        positionMs: 29_870,
        at: s.clock.time,
        paused: false,
        pausedBy: null,
      });
    });

    it('plays the song again, paused, when the bot no longer knows it (it restarted)', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.settled();
      s.clock.advance(10_000);
      s.bot.state.clear();
      await s.service.pause('bob', 'geral');
      expect(s.bot.plays().at(-1)?.request).toMatchObject({
        itemId: item.id,
        offsetMs: 10_000,
        paused: true,
      });
    });

    it('skips a song the bot cannot play and forgets its broken file', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      await cacheSong(s, VIDEO_B);
      s.bot.playError = new JamBotError(422, 'invalid_audio', 'not opus');
      const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
      const second = await s.service.enqueue('alice', 'geral', VIDEO_B);
      await s.service.settled();
      expect(s.service.snapshot().rooms.geral?.current?.item.id).toBe(second.item.id);
      expect(s.bot.plays().map((play) => play.request.itemId)).toEqual([
        first.item.id,
        second.item.id,
      ]);
      expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_B}.webm`]);
    });

    it('keeps the jam while the bot is down and catches it up on reconnection', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      s.bot.unreachable = true;
      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.skip('bob', 'geral', item.id).catch(() => undefined);
      expect(s.service.snapshot().rooms).toEqual({});
      const second = await s.service.enqueue('alice', 'geral', VIDEO_A);
      expect(s.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ room: 'geral' }),
        'could not update the jam bot, retrying',
      );
      expect(
        s.log.warn.mock.calls.filter(([, msg]) => msg === 'could not update the jam bot, retrying'),
      ).toHaveLength(1);

      s.clock.advance(5_000);
      s.bot.unreachable = false;
      await s.bot.reconnect();
      await s.service.settled();
      expect(s.bot.plays().at(-1)?.request).toMatchObject({
        itemId: second.item.id,
        offsetMs: 5_000,
        paused: false,
      });
      expect(s.log.info).toHaveBeenCalledWith(
        expect.objectContaining({ room: 'geral' }),
        'jam bot caught up',
      );
    });
  });

  describe('reconcile', () => {
    it('silences rooms without a jam (leaving after the linger) and fixes the ones it plays wrong', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.settled();
      // While the api was away: the bot plays a stale song in geral and something in jogos.
      s.bot.state.set('geral', {
        room: 'geral',
        itemId: 'old-item',
        state: 'playing',
        positionMs: 0,
        durationMs: 1,
      });
      s.bot.state.set('jogos', {
        room: 'jogos',
        itemId: 'ghost',
        state: 'playing',
        positionMs: 0,
        durationMs: 1,
      });
      s.bot.calls.length = 0;
      await s.bot.reconnect();
      await s.service.settled();
      expect(s.bot.calls[0]).toEqual({ method: 'rooms' });
      expect(s.bot.calls).toHaveLength(3);
      expect(s.bot.calls).toContainEqual({ method: 'pause', room: 'jogos' });
      expect(s.bot.plays()).toEqual([
        { room: 'geral', request: expect.objectContaining({ itemId: item.id }) },
      ]);
      s.clock.advance(JAM_BOT_LINGER_MS);
      s.service.sweep();
      await s.service.settled();
      expect(s.bot.callsOf('leave')).toEqual([{ method: 'leave', room: 'jogos' }]);
    });

    it("adopts the bot's position, and moves on from songs it finished meanwhile", async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      await cacheSong(s, VIDEO_B);
      const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
      const second = await s.service.enqueue('alice', 'geral', VIDEO_B);
      await s.service.settled();
      const status = s.bot.state.get('geral');
      if (!status) throw new Error('the bot should play geral');
      status.positionMs = 42_000;
      s.bot.calls.length = 0;
      await s.bot.reconnect();
      await s.service.settled();
      expect(s.bot.calls).toEqual([{ method: 'rooms' }]);
      expect(s.service.snapshot().rooms.geral?.current).toMatchObject({
        item: { id: first.item.id },
        positionMs: 42_000,
        at: s.clock.time,
      });

      status.state = 'ended'; // the "ended" event was lost
      await s.bot.reconnect();
      await s.service.settled();
      expect(s.bot.plays().at(-1)?.request.itemId).toBe(second.item.id);
    });

    it('resumes a bot left paused when the jam plays', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.settled();
      const status = s.bot.state.get('geral');
      if (status) status.state = 'paused';
      await s.bot.reconnect();
      await s.service.settled();
      expect(s.bot.callsOf('resume')).toHaveLength(1);
      expect(s.bot.state.get('geral')?.state).toBe('playing');
    });
  });

  describe('uploads', () => {
    it('stores the upload as the song, then plays it', async () => {
      const s = await start();
      const { item, upload } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      expect(upload).toBe(true);
      expect(s.bot.plays()).toEqual([]);

      await s.service.upload('alice', 'geral', item.id, audio(4096), 4096);
      await s.service.settled();
      const [probed] = s.bot.probedFiles;
      expect(probed?.startsWith(join(s.cacheDir, '.tmp-'))).toBe(true);
      // Under JAM_STREAM_START_BYTES: checked once whole, played once stored (not growing).
      expect(s.bot.callsOf('probe')).toEqual([{ method: 'probe', file: probed, partial: false }]);
      expect(s.bot.plays()[0]?.request.growing).toBe(false);
      expect(s.bot.callsOf('complete')).toEqual([]);
      expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_A}.webm`]);
      expect((await readFile(join(s.cacheDir, `${VIDEO_A}.webm`))).length).toBe(4096);
      const current = s.service.snapshot().rooms.geral?.current;
      expect(current?.item).toMatchObject({ id: item.id, status: 'ready' });
      // The file's exact duration (from the probe) replaces YouTube Music's.
      expect(current?.item.track.durationMs).toBe(199_500);
      expect(s.bot.plays()[0]?.request.file).toBe(join(s.cacheDir, `${VIDEO_A}.webm`));

      // The next request for the same song needs no upload.
      expect((await s.service.enqueue('bob', 'geral', VIDEO_A)).upload).toBe(false);
    });

    it.each<[string, (s: JamSetup) => void, string]>([
      [
        'the bot rejects the audio',
        (s) => {
          s.bot.probeError = new JamBotError(422, 'invalid_audio', 'no opus track');
        },
        'invalid_audio',
      ],
      [
        'the audio is too long',
        (s) => {
          s.bot.probeResult = { ...s.bot.probeResult, durationMs: JAM_MAX_DURATION_MS + 1 };
        },
        'invalid_audio',
      ],
      [
        'the bot is down',
        (s) => {
          s.bot.probeError = new JamBotError(0, 'unreachable', 'ECONNREFUSED');
        },
        'jam_unavailable',
      ],
    ])('drops the song and the temporary file when %s', async (_label, arrange, expected) => {
      const s = await start();
      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.enqueue('bob', 'geral', VIDEO_A); // waits for the same upload
      arrange(s);
      expect(await rejection(s.service.upload('alice', 'geral', item.id, audio()))).toBe(expected);
      expect(await readdir(s.cacheDir)).toEqual([]);
      expect(s.service.snapshot().rooms).toEqual({});
    });

    it('rejects audio over the limit, announced or streamed', async () => {
      const s = await start({ service: { uploadMaxBytes: 1000 } });
      const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
      expect(
        await rejection(s.service.upload('alice', 'geral', first.item.id, audio(10), 1001)),
      ).toBe('payload_too_large');
      const second = await s.service.enqueue('alice', 'geral', VIDEO_B);
      expect(await rejection(s.service.upload('alice', 'geral', second.item.id, audio(1001)))).toBe(
        'payload_too_large',
      );
      expect(await readdir(s.cacheDir)).toEqual([]);
      expect(s.service.snapshot().rooms).toEqual({});
    });

    it('answers item_not_found when nobody waits for the audio anymore', async () => {
      const s = await start();
      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      const body = audio();
      const uploading = s.service.upload('alice', 'geral', item.id, body);
      await s.service.remove('bob', 'geral', item.id);
      expect(await rejection(uploading)).toBe('item_not_found');
      expect(await readdir(s.cacheDir)).toEqual([]);
    });

    it('drops songs whose audio never came', async () => {
      const s = await start();
      await s.service.enqueue('alice', 'geral', VIDEO_A);
      s.clock.advance(JAM_UPLOAD_TIMEOUT_MS);
      s.service.sweep();
      expect(s.service.snapshot().rooms).toEqual({});
    });

    it('evicts the least recently used songs nobody queued once the cache is full', async () => {
      const s = await start({ cacheMaxBytes: 2500 });
      await cacheSong(s, VIDEO_B, 1000);
      await cacheSong(s, VIDEO_C, 1000);
      const old = new Date(Date.now() - 60_000);
      await utimes(join(s.cacheDir, `${VIDEO_B}.webm`), old, old);
      const { item } = await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.upload('alice', 'geral', item.id, audio(1000));
      // B is the least recently used and not queued: it goes; A plays, C was used later.
      await s.service.maintainCache();
      expect((await readdir(s.cacheDir)).sort()).toEqual([`${VIDEO_A}.webm`, `${VIDEO_C}.webm`]);
    });
  });

  describe('cache upkeep', () => {
    const DAY = 86_400_000;
    const HOUR = 3_600_000;

    async function age(s: JamSetup, videoId: string, ms: number): Promise<void> {
      const time = new Date(Date.now() - ms);
      await utimes(join(s.cacheDir, `${videoId}.webm`), time, time);
    }

    async function ageOf(s: JamSetup, videoId: string): Promise<number> {
      return Date.now() - (await stat(join(s.cacheDir, `${videoId}.webm`))).mtimeMs;
    }

    it('counts a song as used when it is enqueued and when it starts playing', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      await cacheSong(s, VIDEO_B);
      await age(s, VIDEO_A, 3 * DAY);
      const first = await s.service.enqueue('alice', 'geral', VIDEO_A);
      expect(await ageOf(s, VIDEO_A)).toBeLessThan(60_000);
      await s.service.settled();

      await s.service.enqueue('alice', 'geral', VIDEO_B);
      await age(s, VIDEO_B, 3 * DAY); // queued long ago
      s.bot.emit({ type: 'ended', room: 'geral', itemId: first.item.id });
      await s.service.settled();
      expect(await ageOf(s, VIDEO_B)).toBeLessThan(60_000);
    });

    it('deletes songs unused past the TTL at start and then periodically, never a queued one', async () => {
      setup = await jamSetup({ cacheTtlMs: JAM_CACHE_TTL_MS, service: { cacheMaintenanceMs: 20 } });
      const s = setup;
      await cacheSong(s, VIDEO_A);
      await age(s, VIDEO_A, JAM_CACHE_TTL_MS + 60_000);
      await s.service.start();
      await s.service.maintainCache(); // after the one start() runs
      expect(await readdir(s.cacheDir)).toEqual([]);

      await cacheSong(s, VIDEO_B);
      await cacheSong(s, VIDEO_C);
      await s.service.enqueue('alice', 'geral', VIDEO_B);
      await s.service.settled();
      await age(s, VIDEO_B, 4 * HOUR); // playing for "4 hours": still kept
      await age(s, VIDEO_C, 4 * HOUR);
      // No explicit call: the periodic pass (every 20 ms here) finds it.
      await waitFor(() => !existsSync(join(s.cacheDir, `${VIDEO_C}.webm`)));
      expect(await readdir(s.cacheDir)).toEqual([`${VIDEO_B}.webm`]);
    });

    it('deletes temporary uploads left behind', async () => {
      const s = await start();
      await mkdir(s.cacheDir, { recursive: true });
      const leftover = join(s.cacheDir, '.tmp-crashed.webm');
      await writeFile(leftover, 'x');
      const old = new Date(Date.now() - JAM_UPLOAD_TIMEOUT_MS - 1000);
      await utimes(leftover, old, old);
      await s.service.maintainCache();
      expect(await readdir(s.cacheDir)).toEqual([]);
    });
  });

  describe('rules', () => {
    it('asks for a configured room with the caller in it', async () => {
      const s = await start();
      expect(await rejection(s.service.enqueue('alice', 'sala-x', VIDEO_A))).toBe('unknown_room');
      expect(await rejection(s.service.enqueue('carol', 'geral', VIDEO_A))).toBe('not_in_room');
      expect(await rejection(s.service.pause('alice', 'jogos'))).toBe('not_in_room');
    });

    it('validates the song', async () => {
      const s = await start({ tracks: [track(VIDEO_A, { durationMs: JAM_MAX_DURATION_MS + 1 })] });
      expect(await rejection(s.service.enqueue('alice', 'geral', 'not-an-id'))).toBe(
        'invalid_video',
      );
      expect(await rejection(s.service.enqueue('alice', 'geral', VIDEO_B))).toBe('track_not_found');
      expect(await rejection(s.service.enqueue('alice', 'geral', VIDEO_A))).toBe('too_long');
      s.youtube.failing = true;
      expect(await rejection(s.service.enqueue('alice', 'geral', VIDEO_C))).toBe('search_failed');
    });

    it('validates searches', async () => {
      const s = await start();
      expect(await rejection(s.service.search('   '))).toBe('invalid_query');
      expect(await rejection(s.service.search('x'.repeat(101)))).toBe('invalid_query');
      expect(await s.service.search(`  song ${VIDEO_A} `)).toEqual({
        results: [track(VIDEO_A)],
        cached: [],
      });
      expect(s.youtube.searches).toEqual([`song ${VIDEO_A}`]);
      s.youtube.failing = true;
      expect(await rejection(s.service.search('song'))).toBe('search_failed');
    });

    it('is unavailable without a bot, but still searches', async () => {
      const s = await start({ withBot: false });
      expect(s.service.available).toBe(false);
      expect(s.service.snapshot()).toEqual({
        available: false,
        rooms: {},
        serverTime: s.clock.time,
      });
      expect(await rejection(s.service.enqueue('alice', 'geral', VIDEO_A))).toBe('jam_unavailable');
      expect(await rejection(s.service.upload('alice', 'geral', 'x', audio()))).toBe(
        'jam_unavailable',
      );
      expect((await s.service.search('song')).results).toHaveLength(3);
    });
  });

  describe('empty rooms', () => {
    it('clears the jam of a room nobody has been in for two minutes, and the bot leaves', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      await s.service.enqueue('alice', 'geral', VIDEO_A);
      await s.service.settled();
      const events = record(s);
      s.service.sweep();
      s.presence.leave('geral', 'alice');
      s.presence.leave('geral', 'bob');
      s.service.sweep(); // first seen empty
      s.clock.advance(JAM_EMPTY_ROOM_MS - 1);
      s.service.sweep();
      expect(s.service.snapshot().rooms.geral).toBeDefined();
      s.clock.advance(1);
      s.service.sweep();
      await s.service.settled();
      expect(s.service.snapshot().rooms).toEqual({});
      expect(s.bot.callsOf('leave')).toEqual([{ method: 'leave', room: 'geral' }]);
      expect(events.at(-1)).toMatchObject({
        type: 'jam_updated',
        state: { room: 'geral', current: null, queue: [] },
      });
    });

    it('keeps the jam when someone comes back in time', async () => {
      const s = await start();
      await cacheSong(s, VIDEO_A);
      await s.service.enqueue('alice', 'geral', VIDEO_A);
      s.presence.leave('geral', 'alice');
      s.presence.leave('geral', 'bob');
      s.service.sweep();
      s.clock.advance(JAM_EMPTY_ROOM_MS - 1000);
      s.presence.join('geral', { id: 'bob', name: 'Bob', joinedAt: 0 });
      s.service.sweep();
      s.clock.advance(JAM_EMPTY_ROOM_MS);
      s.service.sweep();
      expect(s.service.snapshot().rooms.geral).toBeDefined();
    });
  });

  describe('persistence', () => {
    it('saves the jam and restores it after a restart, catching the bot up', async () => {
      const s = await start({ persist: true });
      await cacheSong(s, VIDEO_A);
      const playing = await s.service.enqueue('alice', 'geral', VIDEO_A);
      const waiting = await s.service.enqueue('bob', 'geral', VIDEO_B);
      s.clock.advance(20_000);
      await s.service.pause('bob', 'geral');
      const before = s.service.snapshot();

      const restarted = await s.restart();
      const saved = JSON.parse(await readFile(s.stateFile, 'utf8')) as { version: number };
      expect(saved.version).toBe(1);
      await restarted.start();
      expect(restarted.snapshot().rooms).toEqual(before.rooms);
      expect(restarted.snapshot().rooms.geral?.queue[0]?.id).toBe(waiting.item.id);

      // The bot kept the paused song: the api adopts it and the requester can still upload.
      s.bot.calls.length = 0;
      await s.bot.reconnect();
      await restarted.settled();
      expect(s.bot.calls).toEqual([{ method: 'rooms' }]);
      expect(restarted.snapshot().rooms.geral?.current?.item.id).toBe(playing.item.id);
      await restarted.upload('bob', 'geral', waiting.item.id, audio());
      expect(restarted.snapshot().rooms.geral?.queue[0]?.status).toBe('ready');
    });

    it('moves a corrupt state file aside and starts empty', async () => {
      setup = await jamSetup({ persist: true });
      await writeFile(setup.stateFile, '{ nope');
      await setup.service.start();
      expect(setup.service.snapshot().rooms).toEqual({});
      const files = await readdir(join(setup.stateFile, '..'));
      expect(files.some((name) => name.startsWith('jam-state.json.corrupt-'))).toBe(true);
    });

    it('leaves the state file alone without a bot', async () => {
      setup = await jamSetup({ persist: true, withBot: false });
      await writeFile(setup.stateFile, '{"version":1,"rooms":[]}');
      await setup.service.start();
      await setup.service.stop();
      expect(await readFile(setup.stateFile, 'utf8')).toBe('{"version":1,"rooms":[]}');
    });
  });
});
