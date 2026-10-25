import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JAM_HISTORY_MAX } from '@concord/shared';
import { JamAudioCache } from '../src/jam/cache';
import { parseJamStateFile } from '../src/jam/state-file';
import { fakeLogger } from './helpers';
import { track, VIDEO_A, VIDEO_B, VIDEO_C } from './jam-helpers';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'concord-jam-infos-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function audio(videoId: string, bytes = 10, ageMs = 0): Promise<void> {
  const path = join(dir, `${videoId}.webm`);
  await writeFile(path, Buffer.alloc(bytes, 1));
  const time = new Date(Date.now() - ageMs);
  await utimes(path, time, time);
}

async function info(videoId: string): Promise<unknown> {
  return JSON.parse(await readFile(join(dir, `${videoId}.json`), 'utf8'));
}

describe('JamAudioCache song infos', () => {
  it('remembers a song once it starts playing, its description and its latest start', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger());
    await audio(VIDEO_A);
    await cache.noteUse(track(VIDEO_A), {}); // not played: nothing to remember
    expect(await readdir(dir)).toEqual([`${VIDEO_A}.webm`]);

    await cache.noteUse(track(VIDEO_A), { playedAt: 5_000 });
    expect(await info(VIDEO_A)).toEqual({ version: 1, track: track(VIDEO_A), playedAt: 5_000 });
    // Only moves forward; the description stays unless the exact one comes.
    await cache.noteUse(track(VIDEO_A, { title: 'Other' }), { playedAt: 4_000 });
    expect(await info(VIDEO_A)).toMatchObject({
      track: { title: `Song ${VIDEO_A}` },
      playedAt: 5_000,
    });
    await cache.noteUse(track(VIDEO_A, { durationMs: 199_500 }), { exact: true });
    expect(await info(VIDEO_A)).toMatchObject({ track: { durationMs: 199_500 }, playedAt: 5_000 });
    // No leftover temporary file.
    expect((await readdir(dir)).sort()).toEqual([`${VIDEO_A}.json`, `${VIDEO_A}.webm`]);
  });

  it('writes nothing for a song whose audio is not here', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger());
    await cache.noteUse(track(VIDEO_A), { playedAt: 1 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('lists the songs that played and are still here, the last to start first', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger());
    expect(await cache.recent()).toEqual([]);
    await audio(VIDEO_A);
    await audio(VIDEO_B);
    await audio(VIDEO_C); // stored, never played: not listed
    await cache.noteUse(track(VIDEO_A), { playedAt: 1_000 });
    await cache.noteUse(track(VIDEO_B), { playedAt: 3_000 });
    expect(await cache.recent()).toEqual([
      { ...track(VIDEO_B), usedAt: 3_000 },
      { ...track(VIDEO_A), usedAt: 1_000 },
    ]);
    await cache.noteUse(track(VIDEO_A), { playedAt: 7_000 });
    expect((await cache.recent()).map((song) => song.videoId)).toEqual([VIDEO_A, VIDEO_B]);
  });

  it('leaves out infos without audio, audio without a valid info, and uploads in progress', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger());
    await audio(VIDEO_A);
    await cache.noteUse(track(VIDEO_A), { playedAt: 1 });
    await writeFile(
      join(dir, `${VIDEO_B}.json`),
      JSON.stringify({ version: 1, track: track(VIDEO_B), playedAt: 2 }),
    );
    await audio(VIDEO_C);
    await writeFile(
      join(dir, `${VIDEO_C}.json`),
      JSON.stringify({ version: 1, track: track(VIDEO_A), playedAt: 2 }),
    );
    await writeFile(join(dir, '.tmp-upload.webm'), 'x');
    await writeFile(join(dir, 'ddddddddddd.webm'), ''); // empty: not a song
    await writeFile(
      join(dir, 'ddddddddddd.json'),
      JSON.stringify({ version: 1, track: track('ddddddddddd'), playedAt: 2 }),
    );
    await audio('eeeeeeeeeee');
    await writeFile(join(dir, 'eeeeeeeeeee.json'), '{ nope');
    expect((await cache.recent()).map((song) => song.videoId)).toEqual([VIDEO_A]);
  });

  it('deletes the info with its audio, and infos left without audio', async () => {
    const cache = new JamAudioCache(dir, 2500, fakeLogger(), { ttlMs: 60_000 });
    await audio(VIDEO_A, 1000, 120_000); // expired
    await audio(VIDEO_B, 1000, 10_000); // evicted (least recently used left)
    await audio(VIDEO_C, 1000, 5_000);
    await audio('ddddddddddd', 1000, 1_000);
    for (const videoId of [VIDEO_A, VIDEO_B, VIDEO_C]) {
      await cache.noteUse(track(videoId), { playedAt: 1 });
    }
    await writeFile(join(dir, 'eeeeeeeeeee.json'), '{}'); // its audio is gone
    expect(await cache.maintain(new Set())).toEqual({
      expired: [VIDEO_A],
      evicted: [VIDEO_B],
      temps: 0,
      orphans: 1,
    });
    expect((await readdir(dir)).sort()).toEqual([
      `${VIDEO_C}.json`,
      `${VIDEO_C}.webm`,
      'ddddddddddd.webm',
    ]);
    expect((await cache.recent()).map((song) => song.videoId)).toEqual([VIDEO_C]);
  });

  it('forgets the info of a song whose audio is discarded', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger());
    await audio(VIDEO_A);
    void cache.noteUse(track(VIDEO_A), { playedAt: 1 });
    await cache.discardSong(VIDEO_A); // after the write already asked for
    expect(await readdir(dir)).toEqual([]);
  });

  it('drops the temporary file of an info left by a crash', async () => {
    const cache = new JamAudioCache(dir, 1_000_000, fakeLogger());
    await writeFile(join(dir, '.tmp-crashed.json'), '{');
    await cache.prepare();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('parseJamStateFile history', () => {
  const item = (id: string, status: 'ready' | 'downloading' = 'ready') => ({
    id,
    track: track(VIDEO_A),
    requestedBy: 'alice',
    addedAt: 1,
    status,
  });

  it('keeps the songs that played, most recent first, without duplicates, within the limit', () => {
    const history = [
      item('h1'),
      item('h2', 'downloading'),
      { id: 'broken' },
      item('q1'), // also queued
      item('h1'),
      ...Array.from({ length: JAM_HISTORY_MAX + 3 }, (_, i) => item(`old-${i}`)),
    ];
    const json = JSON.stringify({
      version: 1,
      rooms: [
        { room: 'geral', current: null, queue: [item('q1')], history },
        { room: 'jogos', current: null, queue: [item('q2')], history: 'nonsense' },
      ],
    });
    const [geral, jogos] = parseJamStateFile(json, ['geral', 'jogos']).rooms;
    const ids = geral?.history?.map((entry) => entry.id) ?? [];
    expect(ids).toHaveLength(JAM_HISTORY_MAX);
    expect(ids.slice(0, 3)).toEqual(['h1', 'old-0', 'old-1']);
    expect(jogos?.history).toEqual([]);
  });
});
