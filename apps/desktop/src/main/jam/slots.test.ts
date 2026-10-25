import { describe, expect, it, vi } from 'vitest';
import { createYtDlpSlots, JAM_MAX_YTDLP_PROCESSES, type YtDlpSlot } from './slots';

/** Lets granted promises and queued microtasks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Records the order in which acquisitions are granted. */
function tracker() {
  const granted: string[] = [];
  const slots: Record<string, YtDlpSlot> = {};
  const track = (name: string) => (slot: YtDlpSlot) => {
    granted.push(name);
    slots[name] = slot;
    return slot;
  };
  return { granted, slots, track };
}

describe('createYtDlpSlots', () => {
  it('runs two yt-dlp processes at most', async () => {
    expect(JAM_MAX_YTDLP_PROCESSES).toBe(2);
    const pool = createYtDlpSlots();
    const { granted, slots, track } = tracker();
    void pool.acquire('job').then(track('a'));
    void pool.acquire('job').then(track('b'));
    void pool.acquire('job').then(track('c'));
    await flush();
    expect(granted).toEqual(['a', 'b']);
    expect(pool.busy).toBe(2);
    slots.a?.release();
    // Releasing twice frees one slot only.
    slots.a?.release();
    await flush();
    expect(granted).toEqual(['a', 'b', 'c']);
    expect(pool.busy).toBe(2);
  });

  it('serves jobs first, in order, then the most recent prefetch', async () => {
    const pool = createYtDlpSlots(1);
    const { granted, slots, track } = tracker();
    void pool.acquire('job').then(track('first'));
    await flush();
    void pool.acquire('prefetch').then(track('p1'));
    void pool.acquire('prefetch').then(track('p2'));
    void pool.acquire('job').then(track('j1'));
    void pool.acquire('job').then(track('j2'));
    await flush();
    for (const next of ['first', 'j1', 'j2', 'p2']) {
      slots[next]?.release();
      await flush();
    }
    expect(granted).toEqual(['first', 'j1', 'j2', 'p2', 'p1']);
  });

  it('stops the oldest prefetch when a job finds every slot taken', async () => {
    const pool = createYtDlpSlots();
    const { granted, slots, track } = tracker();
    const stopOld = vi.fn();
    const stopNew = vi.fn();
    void pool.acquire('prefetch', undefined, stopOld).then(track('old'));
    void pool.acquire('prefetch', undefined, stopNew).then(track('new'));
    await flush();
    void pool.acquire('job').then(track('job'));
    await flush();
    expect(stopOld).toHaveBeenCalledTimes(1);
    expect(stopNew).not.toHaveBeenCalled();
    // Still held until its process is gone: the limit counts real processes.
    expect(granted).toEqual(['old', 'new']);
    slots.old?.release();
    await flush();
    expect(granted).toEqual(['old', 'new', 'job']);

    // A second waiting job stops the other prefetch; a job is never stopped.
    void pool.acquire('job').then(track('job2'));
    void pool.acquire('job').then(track('job3'));
    await flush();
    expect(stopNew).toHaveBeenCalledTimes(1);
    slots.new?.release();
    await flush();
    expect(granted).toEqual(['old', 'new', 'job', 'job2']);
  });

  it('never stops a prefetch whose song was added', async () => {
    const pool = createYtDlpSlots(1);
    const { granted, slots, track } = tracker();
    const stop = vi.fn();
    void pool.acquire('prefetch', undefined, stop).then(track('prefetch'));
    await flush();
    slots.prefetch?.promote();
    void pool.acquire('job').then(track('job'));
    await flush();
    expect(stop).not.toHaveBeenCalled();
    slots.prefetch?.release();
    await flush();
    expect(granted).toEqual(['prefetch', 'job']);
  });

  it('makes room with another prefetch when the one being stopped gets promoted', async () => {
    const pool = createYtDlpSlots();
    const { slots, track } = tracker();
    const stopA = vi.fn();
    const stopB = vi.fn();
    void pool.acquire('prefetch', undefined, stopA).then(track('a'));
    void pool.acquire('prefetch', undefined, stopB).then(track('b'));
    await flush();
    void pool.acquire('job').then(track('job'));
    // Promoted before it had a chance to stop.
    slots.a?.promote();
    await flush();
    expect(stopB).toHaveBeenCalledTimes(1);
  });

  it('lets a waiting acquisition be aborted', async () => {
    const pool = createYtDlpSlots(1);
    const { granted, slots, track } = tracker();
    void pool.acquire('job').then(track('a'));
    const controller = new AbortController();
    const waiting = pool.acquire('job', controller.signal);
    controller.abort(new Error('gone'));
    await expect(waiting).rejects.toThrow('gone');
    void pool.acquire('job').then(track('c'));
    await flush();
    slots.a?.release();
    await flush();
    expect(granted).toEqual(['a', 'c']);
    await expect(pool.acquire('job', controller.signal)).rejects.toThrow('gone');
  });
});
