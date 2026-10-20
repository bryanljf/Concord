import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MusicAppStatus } from '../../preload/api';
import type { MainMessage, SessionSnapshot } from './protocol';
import {
  createNowPlayingService,
  type NowPlayingServiceDeps,
  type NowPlayingWorker,
} from './service';

const T0 = 1_800_000_000_000;
const ART_A = 'aaaaaaaaaaaaaaaa';
const ART_B = 'bbbbbbbbbbbbbbbb';

interface FakeWorker extends NowPlayingWorker {
  posted: MainMessage[];
  killed: boolean;
  emit(message: unknown): void;
  exit(code: number): void;
}

function createHarness(overrides: Partial<NowPlayingServiceDeps> = {}) {
  const workers: FakeWorker[] = [];
  const spawnWorker = vi.fn((): NowPlayingWorker => {
    let onMessage: ((message: unknown) => void) | null = null;
    let onExit: ((code: number) => void) | null = null;
    const worker: FakeWorker = {
      posted: [],
      killed: false,
      onMessage: (listener) => {
        onMessage = listener;
      },
      onExit: (listener) => {
        onExit = listener;
      },
      postMessage: (message) => worker.posted.push(message),
      kill: () => {
        worker.killed = true;
      },
      emit: (message) => onMessage?.(message),
      exit: (code) => onExit?.(code),
    };
    workers.push(worker);
    return worker;
  });
  const isRunning = vi.fn<(names: readonly string[]) => Promise<boolean>>(async () => true);
  const encodeArt = vi.fn((bytes: Uint8Array) =>
    bytes[0] === 0 ? null : `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`,
  );
  const service = createNowPlayingService({
    supported: true,
    spawnWorker,
    isRunning,
    encodeArt,
    ...overrides,
  });
  const pushes: MusicAppStatus[] = [];
  service.onStatus((status) => pushes.push(status));
  const worker = (index = workers.length - 1): FakeWorker => {
    const found = workers[index];
    if (!found) throw new Error(`no worker #${index}`);
    return found;
  };
  return { service, workers, worker, spawnWorker, isRunning, encodeArt, pushes };
}

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sourceAppId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify',
    title: 'Dusk Till Dawn',
    artist: 'Bart Skils',
    album: 'Torn Clouds',
    playbackStatus: 4,
    positionSec: 10,
    durationSec: 300,
    lastUpdatedTime: T0,
    artId: null,
    ...overrides,
  };
}

const sessions = (...list: SessionSnapshot[]) => ({ type: 'sessions', sessions: list });
const artMessage = (artId: string, first = 1) => ({
  type: 'art',
  artId,
  bytes: new Uint8Array([first, 2, 3]),
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Starts the service and lets the worker report `messages` before the first status resolves. */
async function start(harness: ReturnType<typeof createHarness>, ...messages: unknown[]) {
  const pending = harness.service.getStatus('spotify');
  for (const message of messages) harness.worker().emit(message);
  await vi.advanceTimersByTimeAsync(0);
  return pending;
}

describe('startup', () => {
  it('starts nothing until the first getStatus (subscribing alone does not)', async () => {
    const harness = createHarness();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.spawnWorker).not.toHaveBeenCalled();
    expect(harness.isRunning).not.toHaveBeenCalled();

    await start(harness, sessions());
    expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
    expect(harness.isRunning).toHaveBeenCalledWith(['Spotify.exe']);

    await harness.service.getStatus('spotify');
    expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
  });

  it('answers the first getStatus with what the worker reported', async () => {
    const harness = createHarness();
    const status = await start(harness, artMessage(ART_A), sessions(session({ artId: ART_A })));
    expect(status).toEqual({
      app: 'spotify',
      running: true,
      nowPlaying: {
        app: 'spotify',
        title: 'Dusk Till Dawn',
        artist: 'Bart Skils',
        album: 'Torn Clouds',
        state: 'playing',
        ad: false,
        positionMs: 10_000,
        durationMs: 300_000,
        at: T0,
        artId: ART_A,
      },
    });
    expect(harness.service.getArt(ART_A)).toBe('data:image/jpeg;base64,AQID');
  });

  it('does not wait forever for a silent worker', async () => {
    const harness = createHarness({ isRunning: async () => false });
    const pending = harness.service.getStatus('spotify');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ app: 'spotify', running: false, nowPlaying: null });
  });

  it('never spawns anything where SMTC does not exist', async () => {
    const harness = createHarness({ supported: false });
    await expect(harness.service.getStatus('spotify')).resolves.toEqual({
      app: 'spotify',
      running: false,
      nowPlaying: null,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.spawnWorker).not.toHaveBeenCalled();
    expect(harness.isRunning).not.toHaveBeenCalled();
  });
});

describe('pushes', () => {
  it('pushes track, state and seek changes, but not timeline ticks', async () => {
    const harness = createHarness();
    await start(harness, sessions(session()));
    expect(harness.pushes).toHaveLength(1);

    // Three seconds of playback, as the periodic re-sync reports it: nothing new.
    await vi.advanceTimersByTimeAsync(3_000);
    harness.worker().emit(sessions(session({ positionSec: 13, lastUpdatedTime: T0 + 3_000 })));
    harness.worker().emit(sessions(session({ positionSec: 13, lastUpdatedTime: T0 + 3_000 })));
    expect(harness.pushes).toHaveLength(1);

    harness.worker().emit(sessions(session({ playbackStatus: 5, positionSec: 14 })));
    expect(harness.pushes.at(-1)?.nowPlaying?.state).toBe('paused');

    harness.worker().emit(sessions(session({ playbackStatus: 5, positionSec: 120 })));
    expect(harness.pushes.at(-1)?.nowPlaying?.positionMs).toBe(120_000);

    harness.worker().emit(sessions(session({ title: 'Next', positionSec: 0 })));
    expect(harness.pushes.at(-1)?.nowPlaying?.title).toBe('Next');
    expect(harness.pushes).toHaveLength(4);
  });

  it('accepts a cover that arrives after the title', async () => {
    const harness = createHarness();
    await start(harness, sessions(session()));
    expect(harness.pushes.at(-1)?.nowPlaying?.artId).toBeNull();

    harness.worker().emit(artMessage(ART_A));
    harness.worker().emit(sessions(session({ artId: ART_A })));
    expect(harness.pushes.at(-1)?.nowPlaying?.artId).toBe(ART_A);
    expect(harness.pushes).toHaveLength(2);

    // A glitch without the cover keeps it; a new cover for the same track replaces it.
    harness.worker().emit(sessions(session()));
    expect(harness.pushes).toHaveLength(2);
    harness.worker().emit(artMessage(ART_B, 9));
    harness.worker().emit(sessions(session({ artId: ART_B })));
    expect(harness.pushes.at(-1)?.nowPlaying?.artId).toBe(ART_B);
  });

  it('pushes the app closing and opening', async () => {
    const harness = createHarness();
    await start(harness, sessions(session()));
    harness.isRunning.mockResolvedValue(false);

    // The session disappears: nothing plays, and the process is checked right away.
    harness.worker().emit(sessions());
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.pushes.at(-1)).toEqual({ app: 'spotify', running: false, nowPlaying: null });

    harness.isRunning.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.pushes.at(-1)).toEqual({ app: 'spotify', running: true, nowPlaying: null });
  });

  it('does not run tasklist while the app has a media session', async () => {
    const harness = createHarness();
    await start(harness, sessions(session()));
    const calls = harness.isRunning.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.isRunning.mock.calls.length).toBe(calls);
  });

  it('ignores sessions of other apps and malformed messages', async () => {
    const harness = createHarness({ isRunning: async () => false });
    await start(
      harness,
      sessions(session({ sourceAppId: 'Chrome' })),
      { type: 'sessions', sessions: 'nope' },
      { type: 'art', artId: 'NOT-HEX', bytes: new Uint8Array([1]) },
      null,
    );
    expect(harness.pushes).toEqual([{ app: 'spotify', running: false, nowPlaying: null }]);
  });
});

describe('cover art', () => {
  it('serves known covers only, with strict ids', async () => {
    const harness = createHarness();
    await start(harness, artMessage(ART_A), sessions(session({ artId: ART_A })));
    expect(harness.service.getArt(ART_A)).toMatch(/^data:image\/jpeg;base64,/);
    expect(harness.service.getArt(ART_B)).toBeNull();
    expect(harness.service.getArt('../../etc')).toBeNull();
    expect(harness.service.getArt('')).toBeNull();
  });

  it('asks the worker again for a referenced cover it does not have', async () => {
    const harness = createHarness();
    await start(harness, sessions(session({ artId: ART_A })));
    expect(harness.worker().posted).toContainEqual({ type: 'forget-art', artId: ART_A });
    expect(harness.pushes.at(-1)?.nowPlaying?.artId).toBeNull();
  });

  it('does not retry covers that cannot be decoded', async () => {
    const harness = createHarness();
    await start(harness, artMessage(ART_A, 0), sessions(session({ artId: ART_A })));
    harness.worker().emit(artMessage(ART_A, 0));
    expect(harness.encodeArt).toHaveBeenCalledTimes(1);
    expect(harness.worker().posted).toEqual([]);
    expect(harness.pushes.at(-1)?.nowPlaying?.artId).toBeNull();
  });
});

describe('worker lifecycle', () => {
  it('restarts a crashed worker with backoff, forgetting what it reported', async () => {
    const harness = createHarness();
    await start(harness, sessions(session()));

    harness.worker(0).exit(1);
    expect(harness.pushes.at(-1)?.nowPlaying).toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(2);

    harness.worker(1).exit(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(3);

    // A worker that ran for a while restarts quickly again.
    harness.worker(2).emit(sessions(session()));
    expect(harness.pushes.at(-1)?.nowPlaying?.title).toBe('Dusk Till Dawn');
    await vi.advanceTimersByTimeAsync(60_000);
    harness.worker(2).exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(4);
  });

  it('ignores messages and exits from a replaced worker', async () => {
    const harness = createHarness();
    await start(harness, sessions());
    const old = harness.worker(0);
    old.exit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    old.emit(sessions(session({ title: 'Ghost' })));
    old.exit(1);
    expect(harness.pushes.some((status) => status.nowPlaying?.title === 'Ghost')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(2);
  });

  it('gives up for good when the worker reports SMTC unavailable', async () => {
    const harness = createHarness();
    const status = await start(harness, { type: 'unavailable', reason: 'no binary' });
    expect(status).toEqual({ app: 'spotify', running: true, nowPlaying: null });
    expect(harness.worker().killed).toBe(true);
    harness.worker().exit(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
    // The process is still watched.
    harness.isRunning.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.pushes.at(-1)?.running).toBe(false);
  });

  it('treats a worker that cannot be spawned as unavailable', async () => {
    const harness = createHarness({
      spawnWorker: () => {
        throw new Error('fork failed');
      },
    });
    await expect(harness.service.getStatus('spotify')).resolves.toMatchObject({
      running: true,
      nowPlaying: null,
    });
  });

  it('destroy kills the worker and stops polling and restarts', async () => {
    const harness = createHarness();
    await start(harness, sessions());
    harness.service.destroy();
    expect(harness.worker().killed).toBe(true);
    const calls = harness.isRunning.mock.calls.length;
    harness.worker().exit(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.spawnWorker).toHaveBeenCalledTimes(1);
    expect(harness.isRunning.mock.calls.length).toBe(calls);
  });
});
