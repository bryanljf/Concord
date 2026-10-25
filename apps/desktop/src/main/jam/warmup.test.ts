import { describe, expect, it, vi } from 'vitest';
import { deferred } from './async';
import { createYtDlpSlots } from './slots';
import { createJamStore } from './store';
import { createJamWarmUp, type JamWarmUpDeps } from './warmup';
import type { YtDlpBinary } from './ytdlp';

const AVAILABLE = {
  type: 'jam_snapshot',
  data: { available: true, rooms: {}, serverTime: 1 },
} as const;

function setup(overrides: Partial<JamWarmUpDeps> = {}) {
  const store = createJamStore();
  const slots = createYtDlpSlots();
  const ytdlp = {
    warmUp: vi.fn(async (): Promise<YtDlpBinary | null> => ({ path: 'yt-dlp.exe', revision: 1 })),
  };
  const runVersion = vi.fn<JamWarmUpDeps['runVersion']>(async () => '2026.10.21');
  const deps: JamWarmUpDeps = { store, enabled: true, ytdlp, slots, runVersion, ...overrides };
  return { store, slots, ytdlp, runVersion, deps };
}

describe('createJamWarmUp', () => {
  it('runs yt-dlp --version once, as soon as the jam is available', async () => {
    const { store, ytdlp, runVersion, deps } = setup();
    const warmUp = createJamWarmUp(deps);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ytdlp.warmUp).not.toHaveBeenCalled();

    store.apply(AVAILABLE);
    await warmUp.done;
    expect(ytdlp.warmUp).toHaveBeenCalledTimes(1);
    expect(runVersion).toHaveBeenCalledWith('yt-dlp.exe', expect.any(AbortSignal));

    // Once per run of the app, whatever the jam does next.
    store.reset();
    store.apply(AVAILABLE);
    await new Promise((resolve) => setImmediate(resolve));
    expect(ytdlp.warmUp).toHaveBeenCalledTimes(1);
    expect(runVersion).toHaveBeenCalledTimes(1);
  });

  it('starts at once when the jam is already available', async () => {
    const { store, runVersion, deps } = setup();
    store.apply(AVAILABLE);
    await createJamWarmUp(deps).done;
    expect(runVersion).toHaveBeenCalledTimes(1);
  });

  it('does nothing where yt-dlp does not run, or when it is not installed', async () => {
    const elsewhere = setup({ enabled: false });
    elsewhere.store.apply(AVAILABLE);
    await createJamWarmUp(elsewhere.deps).done;
    expect(elsewhere.ytdlp.warmUp).not.toHaveBeenCalled();

    const missing = setup();
    missing.ytdlp.warmUp.mockResolvedValue(null);
    missing.store.apply(AVAILABLE);
    await createJamWarmUp(missing.deps).done;
    expect(missing.runVersion).not.toHaveBeenCalled();
  });

  it('holds a yt-dlp slot like a prefetch, giving it up to an added song', async () => {
    const { store, slots, runVersion, deps } = setup();
    const running = deferred<string | null>();
    const seen: { signal: AbortSignal | null } = { signal: null };
    runVersion.mockImplementation(async (_exePath, signal) => {
      seen.signal = signal;
      signal.addEventListener('abort', () => running.resolve(null));
      return running.promise;
    });
    store.apply(AVAILABLE);
    const warmUp = createJamWarmUp(deps);
    await vi.waitFor(() => expect(runVersion).toHaveBeenCalled());
    expect(slots.busy).toBe(1);

    // Two songs added at once: the warm-up makes room.
    const first = slots.acquire('job');
    const second = slots.acquire('job');
    (await first).release();
    await vi.waitFor(() => expect(seen.signal?.aborted).toBe(true));
    await warmUp.done;
    (await second).release();
    expect(slots.busy).toBe(0);
  });

  it('stops on quit', async () => {
    const { store, runVersion, deps } = setup();
    runVersion.mockImplementation(
      (_exePath, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', () => resolve(null))),
    );
    store.apply(AVAILABLE);
    const warmUp = createJamWarmUp(deps);
    await vi.waitFor(() => expect(runVersion).toHaveBeenCalled());
    warmUp.destroy();
    await warmUp.done;

    // Never started: done anyway.
    const idle = setup();
    const never = createJamWarmUp(idle.deps);
    never.destroy();
    await never.done;
    expect(idle.ytdlp.warmUp).not.toHaveBeenCalled();
  });
});
