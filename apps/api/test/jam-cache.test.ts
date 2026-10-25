import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JAM_CACHE_TTL_MS, type JamState } from '@concord/shared';
import { JamAudioCache } from '../src/jam/cache';
import { JamStateWriter, parseJamStateFile, readJamStateFile } from '../src/jam/state-file';
import type { PersistedJam } from '../src/jam/store';
import { fakeLogger } from './helpers';
import { track, VIDEO_A, VIDEO_B, VIDEO_C } from './jam-helpers';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'concord-jam-cache-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function put(name: string, bytes: number, ageMs = 0): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, Buffer.alloc(bytes, 1));
  const time = new Date(Date.now() - ageMs);
  await utimes(path, time, time);
}

describe('JamAudioCache', () => {
  it('keeps one absolute <videoId>.webm per song and fresh temporary names', () => {
    const cache = new JamAudioCache(dir, 1000, fakeLogger());
    expect(cache.fileFor(VIDEO_A)).toBe(join(dir, `${VIDEO_A}.webm`));
    const temp = cache.tempFile();
    expect(temp.startsWith(join(dir, '.tmp-'))).toBe(true);
    expect(temp.endsWith('.webm')).toBe(true);
    expect(cache.tempFile()).not.toBe(temp);
  });

  it('creates the directory and drops temporary files left by a crash', async () => {
    const cache = new JamAudioCache(join(dir, 'cache'), 1000, fakeLogger());
    await cache.prepare();
    await writeFile(join(dir, 'cache', '.tmp-old.webm'), 'x');
    await writeFile(join(dir, 'cache', `${VIDEO_A}.webm`), 'x');
    await cache.prepare();
    expect(await readdir(join(dir, 'cache'))).toEqual([`${VIDEO_A}.webm`]);
  });

  it('knows which songs it has, and marks them as just used', async () => {
    const cache = new JamAudioCache(dir, 1000, fakeLogger());
    await put(`${VIDEO_A}.webm`, 10, 60_000);
    await put(`${VIDEO_B}.webm`, 0);
    const before = (await stat(join(dir, `${VIDEO_A}.webm`))).mtimeMs;
    expect(await cache.has(VIDEO_A)).toBe(true);
    expect((await stat(join(dir, `${VIDEO_A}.webm`))).mtimeMs).toBeGreaterThan(before);
    expect(await cache.has(VIDEO_B)).toBe(false); // empty: not a song
    expect(await cache.has(VIDEO_C)).toBe(false);
  });

  it('marks a song as used when touched', async () => {
    const cache = new JamAudioCache(dir, 1000, fakeLogger());
    await put(`${VIDEO_A}.webm`, 10, 3_600_000);
    await cache.touch(VIDEO_A);
    await cache.touch(VIDEO_B); // not here: nothing to do
    const age = Date.now() - (await stat(join(dir, `${VIDEO_A}.webm`))).mtimeMs;
    expect(age).toBeLessThan(60_000);
  });

  it('evicts the least recently used songs over the limit, never one still queued', async () => {
    const cache = new JamAudioCache(dir, 2500, fakeLogger());
    await put(`${VIDEO_A}.webm`, 1000, 30_000);
    await put(`${VIDEO_B}.webm`, 1000, 20_000);
    await put(`${VIDEO_C}.webm`, 1000, 10_000);
    await put('.tmp-upload.webm', 5000);
    await put('notes.txt', 5000);
    expect(await cache.maintain(new Set([VIDEO_A]))).toEqual({
      expired: [],
      evicted: [VIDEO_B],
      temps: 0,
    });
    // A fresh temporary file is an upload in progress: it stays, and does not count.
    expect((await readdir(dir)).sort()).toEqual([
      '.tmp-upload.webm',
      `${VIDEO_A}.webm`,
      `${VIDEO_C}.webm`,
      'notes.txt',
    ]);
    expect((await cache.maintain(new Set())).evicted).toEqual([]);
  });

  it('deletes songs unused for longer than the TTL, unless still queued', async () => {
    const day = 86_400_000;
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger(), { ttlMs: 7 * day });
    await put(`${VIDEO_A}.webm`, 10, 8 * day); // old but queued
    await put(`${VIDEO_B}.webm`, 10, 8 * day);
    await put(`${VIDEO_C}.webm`, 10, 6 * day);
    expect(await cache.maintain(new Set([VIDEO_A]))).toEqual({
      expired: [VIDEO_B],
      evicted: [],
      temps: 0,
    });
    expect((await readdir(dir)).sort()).toEqual([`${VIDEO_A}.webm`, `${VIDEO_C}.webm`]);
  });

  it('keeps unused songs when the TTL is 0 (the size limit alone applies)', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger(), { ttlMs: 0 });
    await put(`${VIDEO_A}.webm`, 10, 365 * 86_400_000);
    expect((await cache.maintain(new Set())).expired).toEqual([]);
    expect(await readdir(dir)).toEqual([`${VIDEO_A}.webm`]);
  });

  it('deletes temporary uploads untouched for longer than the upload timeout', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger(), { tempMaxAgeMs: 60_000 });
    await put('.tmp-stale.webm', 10, 61_000);
    await put('.tmp-live.webm', 10, 1_000);
    expect((await cache.maintain(new Set())).temps).toBe(1);
    expect(await readdir(dir)).toEqual(['.tmp-live.webm']);
  });

  it('never deletes the temporary file of an upload in progress, however old', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger(), { tempMaxAgeMs: 60_000 });
    await put('.tmp-slow.webm', 10, 10 * 60_000);
    expect((await cache.maintain(new Set(), new Set([join(dir, '.tmp-slow.webm')]))).temps).toBe(0);
    expect(await readdir(dir)).toEqual(['.tmp-slow.webm']);
  });

  it('deletes songs unused for 3 hours by default', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger(), { ttlMs: JAM_CACHE_TTL_MS });
    await put(`${VIDEO_A}.webm`, 10, JAM_CACHE_TTL_MS + 1000);
    await put(`${VIDEO_B}.webm`, 10, JAM_CACHE_TTL_MS - 60_000);
    expect((await cache.maintain(new Set())).expired).toEqual([VIDEO_A]);
    expect(await readdir(dir)).toEqual([`${VIDEO_B}.webm`]);
  });

  it('tells whether a song is here without counting it as used', async () => {
    const cache = new JamAudioCache(dir, 1000, fakeLogger());
    await put(`${VIDEO_A}.webm`, 10, 3_600_000);
    await put(`${VIDEO_B}.webm`, 0);
    expect(await cache.exists(VIDEO_A)).toBe(true);
    expect(await cache.exists(VIDEO_B)).toBe(false);
    expect(await cache.exists(VIDEO_C)).toBe(false);
    const age = Date.now() - (await stat(join(dir, `${VIDEO_A}.webm`))).mtimeMs;
    expect(age).toBeGreaterThan(3_500_000);
  });

  it('warns when every song over the limit is still queued', async () => {
    const log = fakeLogger();
    const cache = new JamAudioCache(dir, 500, log);
    await put(`${VIDEO_A}.webm`, 1000);
    expect((await cache.maintain(new Set([VIDEO_A]))).evicted).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('has nothing to do without a directory yet', async () => {
    const cache = new JamAudioCache(join(dir, 'missing'), 1, fakeLogger());
    expect(await cache.maintain(new Set())).toEqual({ expired: [], evicted: [], temps: 0 });
  });

  it('moves an upload into place', async () => {
    const cache = new JamAudioCache(dir, 1000, fakeLogger());
    const temp = cache.tempFile();
    await writeFile(temp, 'audio');
    await cache.commit(temp, VIDEO_A);
    expect(await readFile(cache.fileFor(VIDEO_A), 'utf8')).toBe('audio');
    await cache.discard(cache.fileFor(VIDEO_A));
    await cache.discard(cache.fileFor(VIDEO_A)); // already gone: fine
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('parseJamStateFile', () => {
  const item = (id: string, status: 'ready' | 'downloading' = 'ready') => ({
    id,
    track: track(VIDEO_A),
    requestedBy: 'alice',
    addedAt: 1,
    status,
  });
  const current = (id: string) => ({
    item: item(id),
    positionMs: 5,
    at: 10,
    paused: false,
    pausedBy: null,
  });

  it('keeps valid rooms and drops what is malformed or no longer configured', () => {
    const json = JSON.stringify({
      version: 1,
      rooms: [
        {
          room: 'geral',
          current: current('i1'),
          queue: [item('i2'), { id: 'broken' }, item('i1')],
        },
        { room: 'geral', current: null, queue: [item('dup-room')] },
        { room: 'removed-room', current: null, queue: [item('i3')] },
        { room: 'jogos', current: { ...current('i4'), positionMs: -1 }, queue: [] },
        'nonsense',
      ],
      uploads: [
        { videoId: VIDEO_A, itemId: 'i9', room: 'geral', requestedBy: 'bob', deadline: 5 },
        { videoId: 'bad', itemId: 'i9', room: 'geral', requestedBy: 'bob', deadline: 5 },
        { videoId: VIDEO_B, itemId: 'i8', room: 'removed-room', requestedBy: 'bob', deadline: 5 },
      ],
    });
    const parsed = parseJamStateFile(json, ['geral', 'jogos']);
    expect(parsed.rooms).toEqual<JamState[]>([
      { room: 'geral', current: current('i1'), queue: [item('i2')] },
      { room: 'jogos', current: null, queue: [] },
    ]);
    expect(parsed.uploads).toEqual([
      {
        videoId: VIDEO_A,
        itemId: 'i9',
        room: 'geral',
        requestedBy: 'bob',
        deadline: 5,
        receiving: false,
      },
    ]);
  });

  it.each(['{ nope', '[]', '{"version":2,"rooms":[]}', '{"version":1}'])(
    'rejects an unusable file: %s',
    (json) => {
      expect(() => parseJamStateFile(json, ['geral'])).toThrow(/jam state file/);
    },
  );
});

describe('readJamStateFile', () => {
  it('reads nothing from a missing file', async () => {
    expect(await readJamStateFile(join(dir, 'none.json'), ['geral'], fakeLogger())).toBeUndefined();
  });

  it('keeps only the latest copy of a corrupt file', async () => {
    const path = join(dir, 'jam-state.json');
    const log = fakeLogger();
    await writeFile(path, '{ first');
    expect(await readJamStateFile(path, ['geral'], log, () => 1)).toBeUndefined();
    await writeFile(path, '{ second');
    expect(await readJamStateFile(path, ['geral'], log, () => 2)).toBeUndefined();
    expect(await readdir(dir)).toEqual(['jam-state.json.corrupt-2']);
    expect(await readFile(join(dir, 'jam-state.json.corrupt-2'), 'utf8')).toBe('{ second');
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});

describe('JamStateWriter', () => {
  it('writes the latest state, debounced and atomically', async () => {
    const path = join(dir, 'nested', 'jam-state.json');
    let state: PersistedJam = { version: 1, rooms: [], uploads: [] };
    const writer = new JamStateWriter({
      path,
      read: () => state,
      log: fakeLogger(),
      debounceMs: 20,
    });
    writer.schedule();
    state = { version: 1, rooms: [{ room: 'geral', current: null, queue: [] }], uploads: [] };
    writer.schedule();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(state);

    state = { version: 1, rooms: [], uploads: [] };
    writer.schedule();
    await writer.flush();
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(state);
    expect(await readdir(join(dir, 'nested'))).toEqual(['jam-state.json']);
  });

  it('logs a failed write instead of throwing', async () => {
    const log = fakeLogger();
    await mkdir(join(dir, 'taken.json'));
    const writer = new JamStateWriter({
      path: join(dir, 'taken.json'),
      read: () => ({ version: 1, rooms: [], uploads: [] }),
      log,
    });
    await writer.flush();
    expect(log.error).toHaveBeenCalledTimes(1);
  });
});
