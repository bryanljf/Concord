import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJamDownload, type JamDownloadFeed } from './download';
import { createJamPrefetcher, JAM_PREFETCH_MAX, JAM_PREFETCH_TTL_MS } from './prefetch';
import { createYtDlpSlots } from './slots';
import { YtDlpError } from './ytdlp';

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
const [A, B, C, D] = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'] as const;

/** Lets the prefetches' promise chains run (no timers involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function setup() {
  const slots = createYtDlpSlots();
  const ytdlp = {
    ensure: vi.fn(async () => ({ path: 'yt-dlp.exe', revision: 7 })),
  };
  /** Every yt-dlp started, by video id; killing one ends its process. */
  const feeds = new Map<string, JamDownloadFeed>();
  const startDownload = vi.fn((exePath: string, videoId: string) => {
    expect(exePath).toBe('yt-dlp.exe');
    const feed = createJamDownload(videoId);
    feed.onStop(() => feed.gone());
    feeds.set(videoId, feed);
    return feed.download;
  });
  const prefetcher = createJamPrefetcher({ ytdlp, slots, startDownload });
  /** yt-dlp finished `videoId` well. */
  const finish = (videoId: string): void => {
    const feed = feeds.get(videoId);
    feed?.push(WEBM);
    feed?.complete();
    feed?.gone();
  };
  const started = () => startDownload.mock.calls.map(([, videoId]) => videoId);
  const held = () => prefetcher.list().map((entry) => `${entry.videoId[0]}:${entry.state}`);
  return { prefetcher, slots, ytdlp, feeds, startDownload, finish, started, held };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createJamPrefetcher', () => {
  it('keeps three songs at most, dropping the least recently requested', async () => {
    expect(JAM_PREFETCH_MAX).toBe(3);
    const { prefetcher, feeds, started, held, slots } = setup();
    prefetcher.prefetch([A]);
    prefetcher.prefetch([B]);
    prefetcher.prefetch([C]);
    await settle();
    // Two yt-dlp processes at most: the third waits.
    expect(started()).toEqual([A, B]);
    expect(held()).toEqual(['c:pending', 'b:running', 'a:running']);

    prefetcher.prefetch([D]);
    await settle();
    // A was dropped (its yt-dlp killed) and the one waiting took its slot.
    expect(feeds.get(A)?.download.error?.reason).toBe('cancelled');
    expect(started()).toEqual([A, B, C]);
    expect(held()).toEqual(['d:pending', 'c:running', 'b:running']);
    expect(slots.busy).toBe(2);
  });

  it('counts a request again as the most recent one', async () => {
    const { prefetcher, finish, held } = setup();
    prefetcher.prefetch([A, B, C]);
    await settle();
    // The first id of a call counts as the most recent.
    expect(held()).toEqual(['a:running', 'b:running', 'c:pending']);
    finish(A);
    finish(B);
    await settle();
    prefetcher.prefetch([C]);
    prefetcher.prefetch([A]);
    prefetcher.prefetch([D]);
    await settle();
    expect(held().map((entry) => entry[0])).toEqual(['d', 'a', 'c']);
  });

  it('drops a song a few minutes after it was last requested', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { prefetcher, feeds, finish } = setup();
    prefetcher.prefetch([A]);
    await settle();
    vi.advanceTimersByTime(JAM_PREFETCH_TTL_MS - 1000);
    prefetcher.prefetch([A]);
    vi.advanceTimersByTime(JAM_PREFETCH_TTL_MS - 1000);
    expect(prefetcher.list()).toHaveLength(1);
    expect(feeds.get(A)?.download.state).toBe('running');
    vi.advanceTimersByTime(1000);
    expect(prefetcher.list()).toEqual([]);
    expect(feeds.get(A)?.download.error?.reason).toBe('cancelled');

    // A finished one is dropped (and its bytes with it) the same way.
    prefetcher.prefetch([B]);
    await settle();
    finish(B);
    await settle();
    expect(prefetcher.list()).toEqual([{ videoId: B, state: 'complete', size: WEBM.length }]);
    vi.advanceTimersByTime(JAM_PREFETCH_TTL_MS);
    expect(prefetcher.list()).toEqual([]);
  });

  it('hands a running download over to the added song, never starting it again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { prefetcher, feeds, slots, started } = setup();
    prefetcher.prefetch([A]);
    prefetcher.prefetch([B]);
    await settle();
    const taken = prefetcher.take(A);
    expect(taken?.download).toBe(feeds.get(A)?.download);
    expect(taken?.revision).toBe(7);
    expect(prefetcher.list().map((entry) => entry.videoId)).toEqual([B]);
    // No longer subject to the prefetch rules: B expires, A goes on.
    vi.advanceTimersByTime(JAM_PREFETCH_TTL_MS);
    expect(taken?.download.state).toBe('running');
    expect(feeds.get(B)?.download.error?.reason).toBe('cancelled');
    await settle();

    // Its slot is a job's now: a job finding both slots taken stops the prefetch, never it.
    prefetcher.prefetch([C]);
    await settle();
    expect(started()).toEqual([A, B, C]);
    const job = slots.acquire('job');
    await settle();
    expect(feeds.get(C)?.download.error?.reason).toBe('cancelled');
    expect(feeds.get(A)?.download.state).toBe('running');
    (await job).release();
    expect(prefetcher.take(A)).toBeNull();
  });

  it('hands a finished download over with its bytes', async () => {
    const { prefetcher, finish } = setup();
    prefetcher.prefetch([A]);
    await settle();
    finish(A);
    await settle();
    const taken = prefetcher.take(A);
    expect(taken?.download.state).toBe('complete');
    expect(taken?.download.bytes()).toEqual(WEBM);
    expect(prefetcher.list()).toEqual([]);
  });

  it('lets a song added before its prefetch started download on its own', async () => {
    const { prefetcher, finish, started } = setup();
    prefetcher.prefetch([A, B, C]);
    await settle();
    expect(prefetcher.take(C)).toBeNull();
    finish(A);
    await settle();
    // C never starts: its job downloads it, first in line.
    expect(started()).toEqual([A, B]);
    expect(prefetcher.list().map((entry) => entry.videoId)).toEqual([A, B]);
  });

  it('remembers a failure until it expires instead of retrying', async () => {
    const { prefetcher, feeds, started } = setup();
    prefetcher.prefetch([A]);
    await settle();
    feeds.get(A)?.fail('blocked');
    feeds.get(A)?.gone();
    await settle();
    expect(prefetcher.list()).toEqual([{ videoId: A, state: 'failed', size: 0 }]);
    prefetcher.prefetch([A]);
    await settle();
    expect(started()).toEqual([A]);
    // The job gets the real error by downloading itself.
    expect(prefetcher.take(A)).toBeNull();
    expect(prefetcher.list()).toEqual([]);
  });

  it('fails quietly without a yt-dlp', async () => {
    const { prefetcher, ytdlp, startDownload } = setup();
    ytdlp.ensure.mockRejectedValue(new YtDlpError('Sem yt-dlp.'));
    prefetcher.prefetch([A]);
    await settle();
    expect(startDownload).not.toHaveBeenCalled();
    expect(prefetcher.list()).toEqual([{ videoId: A, state: 'failed', size: 0 }]);
  });

  it('drops everything on clear, and single songs on discard', async () => {
    const { prefetcher, feeds, started, slots } = setup();
    prefetcher.prefetch([A, B, C]);
    await settle();
    prefetcher.discard(B);
    await settle();
    expect(feeds.get(B)?.download.error?.reason).toBe('cancelled');
    expect(started()).toEqual([A, B, C]);
    prefetcher.clear();
    await settle();
    expect(prefetcher.list()).toEqual([]);
    expect(feeds.get(A)?.download.error?.reason).toBe('cancelled');
    expect(feeds.get(C)?.download.error?.reason).toBe('cancelled');
    expect(slots.busy).toBe(0);
  });
});
