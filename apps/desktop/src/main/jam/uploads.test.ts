import type { JamItem, JamState } from '@concord/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JamUploadStatus } from '../../preload/api';
import { ApiClientError } from '../api-client';
import { createJamDownload, JAM_DOWNLOAD_MESSAGES, type JamDownloadFeed } from './download';
import type { PrefetchedAudio } from './prefetch';
import { createYtDlpSlots } from './slots';
import { createJamStore } from './store';
import {
  createJamUploads,
  JAM_ITEM_GONE_MESSAGE,
  JAM_UPLOAD_STATUS_TTL_MS,
  type JamUploadsDeps,
} from './uploads';
import { YtDlpError, type EnsureOptions, type YtDlpBinary } from './ytdlp';

const HEAD = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
const TAIL = Buffer.from([2, 3, 4]);

function jamItem(id: string, videoId = '4D7u5KF7SP8'): JamItem {
  return {
    id,
    track: {
      videoId,
      title: `Song ${id}`,
      artists: 'Artist',
      album: null,
      durationMs: 200_000,
      artworkUrl: null,
    },
    requestedBy: 'bryan',
    addedAt: 1,
    status: 'downloading',
  };
}

/** Lets the jobs' promise chains run (no timers involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A fake yt-dlp: the test feeds it; killing it ends its process. */
function fakeDownload(videoId: string): JamDownloadFeed {
  const feed = createJamDownload(videoId);
  feed.onStop(() => feed.gone());
  return feed;
}

/** yt-dlp sent everything and exited. */
function finish(feed: JamDownloadFeed | undefined, ...chunks: Buffer[]): void {
  for (const chunk of chunks) feed?.push(chunk);
  feed?.complete();
  feed?.gone();
}

function setup(overrides: Partial<JamUploadsDeps> = {}) {
  let revision = 1;
  const ytdlp = {
    needsInstall: vi.fn(() => false),
    ensure: vi.fn<(options?: EnsureOptions) => Promise<YtDlpBinary>>(async () => ({
      path: 'yt-dlp.exe',
      revision,
    })),
  };
  /** What the server received, per request. */
  const received: Buffer[][] = [];
  const api = {
    // Reads the whole body like the server does, then answers 204.
    jamUpload: vi.fn<JamUploadsDeps['api']['jamUpload']>(async (_room, _itemId, body) => {
      const chunks: Buffer[] = [];
      received.push(chunks);
      if (body instanceof Uint8Array) {
        chunks.push(Buffer.from(body));
        return;
      }
      const reader = body.getReader();
      for (;;) {
        let result;
        try {
          result = await reader.read();
        } catch {
          // What fetch says when its body breaks.
          throw new ApiClientError('network', 'Falha de rede.');
        }
        if (result.done) return;
        chunks.push(Buffer.from(result.value));
      }
    }),
    jamRemove: vi.fn<JamUploadsDeps['api']['jamRemove']>(async () => undefined),
    jamFetchDecline: vi.fn<JamUploadsDeps['api']['jamFetchDecline']>(async () => undefined),
  };
  const feeds: JamDownloadFeed[] = [];
  const startDownload = vi.fn((_exePath: string, videoId: string) => {
    const feed = fakeDownload(videoId);
    feeds.push(feed);
    return feed.download;
  });
  const slots = createYtDlpSlots();
  const store = createJamStore();
  const uploads = createJamUploads({
    api,
    ytdlp,
    startDownload,
    slots,
    store,
    retryDelayMs: 0,
    ...overrides,
  });
  const statuses: JamUploadStatus[] = [];
  uploads.onStatus((status) => statuses.push(status));
  const states = (itemId: string) =>
    statuses.filter((status) => status.itemId === itemId).map((status) => status.state);
  const sent = (request = 0) => Buffer.concat(received[request] ?? []);
  return {
    uploads,
    api,
    ytdlp,
    feeds,
    startDownload,
    slots,
    store,
    statuses,
    states,
    received,
    sent,
    bumpRevision: () => {
      revision += 1;
    },
  };
}

function inQueue(...items: JamItem[]): JamState {
  return { room: 'sala-1', current: null, queue: items };
}

/** A server that answers `err` after the first bytes, before the rest. */
function answeredWith(err: Error) {
  return vi.fn<JamUploadsDeps['api']['jamUpload']>(async (_room, _itemId, body) => {
    if (body instanceof ReadableStream) await body.getReader().read();
    throw err;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createJamUploads', () => {
  it('streams the audio while yt-dlp still downloads it, then reports done', async () => {
    const { uploads, api, feeds, startDownload, statuses, states, sent, received } = setup();
    uploads.start('sala-1', jamItem('a'));
    expect(statuses[0]).toEqual({
      itemId: 'a',
      room: 'sala-1',
      title: 'Song a',
      state: 'downloading',
      message: null,
    });
    await settle();
    expect(startDownload).toHaveBeenCalledWith('yt-dlp.exe', '4D7u5KF7SP8');
    // Nothing is sent before the first bytes look like WebM.
    expect(api.jamUpload).not.toHaveBeenCalled();

    feeds[0]?.push(HEAD);
    await settle();
    expect(api.jamUpload).toHaveBeenCalledWith(
      'sala-1',
      'a',
      expect.any(ReadableStream),
      expect.any(AbortSignal),
    );
    // The server already has the first bytes while yt-dlp still runs.
    expect(received[0]).toEqual([HEAD]);
    expect(states('a')).toEqual(['downloading']);

    finish(feeds[0], TAIL);
    await settle();
    expect(sent()).toEqual(Buffer.concat([HEAD, TAIL]));
    expect(states('a')).toEqual(['downloading', 'uploading', 'done']);
    expect(api.jamRemove).not.toHaveBeenCalled();
    expect(uploads.list()).toEqual([{ ...statuses[0], state: 'done' }]);
  });

  it('says preparing only while yt-dlp is being fetched or updated', async () => {
    const first = setup();
    first.ytdlp.needsInstall.mockReturnValue(true);
    first.uploads.start('sala-1', jamItem('a'));
    await settle();
    finish(first.feeds[0], HEAD);
    await settle();
    expect(first.states('a')).toEqual(['preparing', 'downloading', 'uploading', 'done']);

    const update = setup();
    update.ytdlp.ensure.mockImplementation(async (options?: EnsureOptions) => {
      options?.onPreparing?.();
      return { path: 'yt-dlp.exe', revision: 2 };
    });
    update.uploads.start('sala-1', jamItem('b'));
    await settle();
    finish(update.feeds[0], HEAD);
    await settle();
    expect(update.states('b')).toEqual([
      'downloading',
      'preparing',
      'downloading',
      'uploading',
      'done',
    ]);
  });

  it('removes the song and reports the message when the download fails', async () => {
    const { uploads, api, feeds, statuses } = setup();
    uploads.start('sala-1', jamItem('a'));
    await settle();
    feeds[0]?.fail('blocked');
    await settle();
    expect(statuses.at(-1)).toEqual({
      itemId: 'a',
      room: 'sala-1',
      title: 'Song a',
      state: 'error',
      message: 'O YouTube bloqueou o download nesta conexão. Tente de novo mais tarde.',
    });
    expect(api.jamRemove).toHaveBeenCalledWith('sala-1', 'a');
    expect(api.jamUpload).not.toHaveBeenCalled();
  });

  it('reports the download’s failure when it breaks while being sent', async () => {
    const { uploads, api, feeds, statuses } = setup();
    uploads.start('sala-1', jamItem('a'));
    await settle();
    feeds[0]?.push(HEAD);
    await settle();
    feeds[0]?.fail('network');
    await settle();
    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      message: JAM_DOWNLOAD_MESSAGES.network,
    });
    // Never sent again: the server dropped the song already.
    expect(api.jamUpload).toHaveBeenCalledTimes(1);
    expect(api.jamRemove).toHaveBeenCalledWith('sala-1', 'a');
  });

  it('reports a yt-dlp that could not be prepared', async () => {
    const { uploads, ytdlp, statuses, api } = setup();
    ytdlp.ensure.mockRejectedValue(new YtDlpError('Sem yt-dlp.'));
    uploads.start('sala-1', jamItem('a'));
    await settle();
    expect(statuses.at(-1)).toMatchObject({ state: 'error', message: 'Sem yt-dlp.' });
    expect(api.jamRemove).toHaveBeenCalledWith('sala-1', 'a');
  });

  it('updates yt-dlp once and retries after an outdated-looking failure', async () => {
    const { uploads, ytdlp, feeds, startDownload, states, bumpRevision } = setup();
    ytdlp.ensure.mockImplementation(async (options?: EnsureOptions) => {
      if (options?.force) {
        options.onPreparing?.();
        bumpRevision();
        return { path: 'yt-dlp.exe', revision: 2 };
      }
      return { path: 'yt-dlp.exe', revision: 1 };
    });
    uploads.start('sala-1', jamItem('a'));
    await settle();
    feeds[0]?.fail('outdated');
    feeds[0]?.gone();
    await settle();
    expect(ytdlp.ensure).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
    expect(startDownload).toHaveBeenCalledTimes(2);
    finish(feeds[1], HEAD);
    await settle();
    expect(states('a')).toEqual(['downloading', 'preparing', 'downloading', 'uploading', 'done']);
  });

  it('gives up when the forced check finds no newer yt-dlp', async () => {
    const { uploads, feeds, startDownload, statuses } = setup();
    uploads.start('sala-1', jamItem('a'));
    await settle();
    feeds[0]?.fail('outdated');
    await settle();
    expect(startDownload).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      message: 'O YouTube mudou algo e o yt-dlp ainda não acompanhou. Tente de novo mais tarde.',
    });
  });

  it('takes the server’s answer as final, even one that comes while sending', async () => {
    const answer = (err: Error) =>
      vi.fn<JamUploadsDeps['api']['jamUpload']>(async (_room, _itemId, body) => {
        // Answered after the first bytes, before the rest.
        if (body instanceof ReadableStream) await body.getReader().read();
        throw err;
      });

    const gone = setup();
    gone.api.jamUpload = answer(new ApiClientError('http', 'x', 404, 'item_not_found'));
    gone.uploads.start('sala-1', jamItem('a'));
    await settle();
    gone.feeds[0]?.push(HEAD);
    await settle();
    expect(gone.statuses.at(-1)).toMatchObject({ state: 'error', message: JAM_ITEM_GONE_MESSAGE });
    expect(gone.api.jamRemove).not.toHaveBeenCalled();
    // The download nobody needs anymore is stopped.
    expect(gone.feeds[0]?.download.error?.reason).toBe('cancelled');

    const already = setup();
    already.api.jamUpload = answer(new ApiClientError('http', 'x', 409, 'already_uploaded'));
    already.uploads.start('sala-1', jamItem('a'));
    await settle();
    already.feeds[0]?.push(HEAD);
    await settle();
    expect(already.states('a').at(-1)).toBe('done');

    const refused = setup();
    refused.api.jamUpload = answer(
      new ApiClientError('http', 'O servidor recusou o áudio.', 422, 'invalid_audio'),
    );
    refused.uploads.start('sala-1', jamItem('a'));
    await settle();
    refused.feeds[0]?.push(HEAD);
    await settle();
    expect(refused.statuses.at(-1)).toMatchObject({
      state: 'error',
      message: 'O servidor recusou o áudio.',
    });
    expect(refused.api.jamRemove).toHaveBeenCalledWith('sala-1', 'a');

    for (const err of [
      new ApiClientError('http', 'A Jam está fora do ar.', 503, 'jam_unavailable'),
      new ApiClientError('network', 'Falha de rede.'),
      new ApiClientError('timeout', 'Demorou.'),
    ]) {
      const failed = setup();
      failed.api.jamUpload = answer(err);
      failed.uploads.start('sala-1', jamItem('a'));
      await settle();
      failed.feeds[0]?.push(HEAD);
      await settle();
      // Sending the same song again would only get a 404: the server dropped it.
      expect(failed.api.jamUpload).toHaveBeenCalledTimes(1);
      expect(failed.statuses.at(-1)).toMatchObject({ state: 'error', message: err.message });
    }

    const unexpected = setup();
    unexpected.api.jamUpload = answer(new Error('boom'));
    unexpected.uploads.start('sala-1', jamItem('a'));
    await settle();
    unexpected.feeds[0]?.push(HEAD);
    await settle();
    expect(unexpected.statuses.at(-1)).toMatchObject({
      state: 'error',
      message: 'Não foi possível enviar a música para a Jam.',
    });
  });

  it('sends again, from the first byte, a request that never reached the server', async () => {
    const { uploads, api, feeds, states, sent } = setup();
    // Refused before its body was read.
    api.jamUpload.mockImplementationOnce(async () => {
      throw new ApiClientError('network', 'Falha de rede.');
    });
    uploads.start('sala-1', jamItem('a'));
    await settle();
    feeds[0]?.push(HEAD);
    await vi.waitFor(() => expect(api.jamUpload).toHaveBeenCalledTimes(2));
    finish(feeds[0], TAIL);
    await settle();
    // The second request got every byte, from the first.
    expect(sent(0)).toEqual(Buffer.concat([HEAD, TAIL]));
    expect(states('a').at(-1)).toBe('done');
  });

  it('takes over the prefetch of its song, without starting yt-dlp again', async () => {
    const prefetched = fakeDownload('4D7u5KF7SP8');
    prefetched.push(HEAD);
    const take = vi.fn((): PrefetchedAudio | null => ({
      download: prefetched.download,
      revision: 1,
    }));
    const { uploads, ytdlp, startDownload, states, sent } = setup({ prefetches: { take } });
    uploads.start('sala-1', jamItem('a'));
    expect(take).toHaveBeenCalledWith('4D7u5KF7SP8');
    await settle();
    expect(ytdlp.ensure).not.toHaveBeenCalled();
    expect(startDownload).not.toHaveBeenCalled();
    // The bytes the prefetch had are sent at once.
    expect(sent()).toEqual(HEAD);
    finish(prefetched, TAIL);
    await settle();
    expect(sent()).toEqual(Buffer.concat([HEAD, TAIL]));
    expect(states('a')).toEqual(['downloading', 'uploading', 'done']);

    // Prefetched entirely: only the sending is left.
    const complete = fakeDownload('4D7u5KF7SP8');
    finish(complete, HEAD, TAIL);
    const done = setup({
      prefetches: { take: () => ({ download: complete.download, revision: 1 }) },
    });
    done.uploads.start('sala-1', jamItem('b'));
    await settle();
    expect(done.sent()).toEqual(Buffer.concat([HEAD, TAIL]));
    expect(done.states('b')).toEqual(['uploading', 'done']);
  });

  it('downloads on its own when the prefetch it took fails like an outdated yt-dlp', async () => {
    const prefetched = fakeDownload('4D7u5KF7SP8');
    const { uploads, ytdlp, feeds, startDownload, states } = setup({
      prefetches: { take: () => ({ download: prefetched.download, revision: 1 }) },
    });
    ytdlp.ensure.mockResolvedValue({ path: 'yt-dlp.exe', revision: 2 });
    uploads.start('sala-1', jamItem('a'));
    await settle();
    prefetched.fail('format');
    await settle();
    expect(ytdlp.ensure).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
    expect(startDownload).toHaveBeenCalledTimes(1);
    finish(feeds[0], HEAD);
    await settle();
    expect(states('a').at(-1)).toBe('done');
  });

  it('runs two yt-dlp processes at most', async () => {
    const { uploads, feeds, startDownload, states } = setup();
    uploads.start('sala-1', jamItem('a'));
    uploads.start('sala-1', jamItem('b'));
    uploads.start('sala-1', jamItem('c'));
    uploads.start('sala-1', jamItem('c'));
    await settle();
    expect(startDownload).toHaveBeenCalledTimes(2);
    expect(uploads.list().map((status) => status.itemId)).toEqual(['a', 'b', 'c']);

    finish(feeds[0], HEAD);
    await settle();
    expect(states('a').at(-1)).toBe('done');
    expect(startDownload).toHaveBeenCalledTimes(3);
    finish(feeds[1], HEAD);
    finish(feeds[2], HEAD);
    await settle();
    expect(uploads.list().map((status) => status.state)).toEqual(['done', 'done', 'done']);
  });

  it('stops a job whose song left the queue', async () => {
    const { uploads, feeds, store, statuses, api } = setup();
    const item = jamItem('a');
    store.apply({
      type: 'jam_snapshot',
      data: { available: true, rooms: { 'sala-1': inQueue(item) }, serverTime: 1 },
    });
    uploads.start('sala-1', item);
    await settle();
    feeds[0]?.push(HEAD);
    await settle();
    // Losing the connection says nothing about the queue.
    store.reset();
    await settle();
    expect(feeds[0]?.download.state).toBe('running');
    store.apply({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: 2 } });
    await settle();
    expect(feeds[0]?.download.error?.reason).toBe('cancelled');
    expect(statuses.at(-1)).toMatchObject({ state: 'error', message: JAM_ITEM_GONE_MESSAGE });
    expect(api.jamRemove).not.toHaveBeenCalled();
  });

  it('waits for the song to show up in the jam before watching it', async () => {
    const { uploads, feeds, store, states } = setup();
    const item = jamItem('a');
    store.apply({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: 1 } });
    // The enqueue answer can arrive before the jam event that contains the song.
    uploads.start('sala-1', item);
    store.apply({ type: 'jam_updated', state: inQueue(jamItem('other')), serverTime: 2 });
    store.apply({ type: 'jam_updated', state: inQueue(jamItem('other'), item), serverTime: 3 });
    await settle();
    finish(feeds[0], HEAD);
    await settle();
    expect(states('a').at(-1)).toBe('done');
  });

  it('cancels everything silently on logout or quit', async () => {
    const { uploads, feeds, startDownload, statuses, api, slots } = setup();
    uploads.start('sala-1', jamItem('a'));
    uploads.start('sala-1', jamItem('b'));
    uploads.start('sala-1', jamItem('c'));
    await settle();
    feeds[0]?.push(HEAD);
    await settle();
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(true);
    const before = statuses.length;
    uploads.cancelAll();
    await settle();
    expect(feeds.map((feed) => feed.download.error?.reason)).toEqual(['cancelled', 'cancelled']);
    expect(uploads.list()).toEqual([]);
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(false);
    expect(statuses).toHaveLength(before);
    expect(api.jamRemove.mock.calls.map((args) => args[1]).sort()).toEqual(['a', 'b', 'c']);
    // The waiting job never got to download.
    expect(startDownload).toHaveBeenCalledTimes(2);
    expect(slots.busy).toBe(0);
  });

  it('forgets finished statuses after a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { uploads, feeds } = setup();
    uploads.start('sala-1', jamItem('a'));
    await settle();
    finish(feeds[0], HEAD);
    await settle();
    expect(uploads.list()).toHaveLength(1);
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(false);
    vi.advanceTimersByTime(JAM_UPLOAD_STATUS_TTL_MS - 1);
    expect(uploads.list()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(uploads.list()).toEqual([]);
  });
});

describe('delegated jobs (songs sent at the server’s request)', () => {
  it('sends the audio like any other job, without a word to anyone', async () => {
    const { uploads, api, feeds, startDownload, statuses, sent } = setup();
    uploads.start('sala-1', jamItem('a'), { delegated: true });
    expect(statuses).toEqual([]);
    expect(uploads.list()).toEqual([]);
    // Still a download in progress: prefetching the same song would be wasted.
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(true);
    await settle();
    expect(startDownload).toHaveBeenCalledWith('yt-dlp.exe', '4D7u5KF7SP8');
    feeds[0]?.push(HEAD);
    await settle();
    expect(api.jamUpload).toHaveBeenCalledWith(
      'sala-1',
      'a',
      expect.any(ReadableStream),
      expect.any(AbortSignal),
    );
    finish(feeds[0], TAIL);
    await settle();
    expect(sent()).toEqual(Buffer.concat([HEAD, TAIL]));
    expect(statuses).toEqual([]);
    expect(uploads.list()).toEqual([]);
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(false);
    expect(api.jamRemove).not.toHaveBeenCalled();
    expect(api.jamFetchDecline).not.toHaveBeenCalled();
    // Asked for the same song again while it is remembered: nothing starts twice.
    uploads.start('sala-1', jamItem('a'), { delegated: true });
    expect(startDownload).toHaveBeenCalledTimes(1);
  });

  it('takes over the prefetch of its song', async () => {
    const prefetched = fakeDownload('4D7u5KF7SP8');
    finish(prefetched, HEAD, TAIL);
    const take = vi.fn((): PrefetchedAudio | null => ({
      download: prefetched.download,
      revision: 1,
    }));
    const { uploads, ytdlp, startDownload, statuses, sent } = setup({ prefetches: { take } });
    uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    expect(take).toHaveBeenCalledWith('4D7u5KF7SP8');
    expect(ytdlp.ensure).not.toHaveBeenCalled();
    expect(startDownload).not.toHaveBeenCalled();
    expect(sent()).toEqual(Buffer.concat([HEAD, TAIL]));
    expect(statuses).toEqual([]);
  });

  it('declines the fetch instead of removing the song when it fails', async () => {
    const blocked = setup();
    blocked.uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    blocked.feeds[0]?.fail('blocked');
    await settle();
    expect(blocked.api.jamFetchDecline).toHaveBeenCalledWith(
      'sala-1',
      'a',
      'download failed: blocked',
    );
    expect(blocked.api.jamRemove).not.toHaveBeenCalled();
    expect(blocked.api.jamUpload).not.toHaveBeenCalled();
    expect(blocked.statuses).toEqual([]);
    expect(blocked.uploads.list()).toEqual([]);
    expect(blocked.uploads.isSending('4D7u5KF7SP8')).toBe(false);

    const noYtDlp = setup();
    noYtDlp.ytdlp.ensure.mockRejectedValue(new YtDlpError('Sem yt-dlp.'));
    noYtDlp.uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    expect(noYtDlp.api.jamFetchDecline).toHaveBeenCalledWith('sala-1', 'a', 'yt-dlp unavailable');
    expect(noYtDlp.statuses).toEqual([]);

    // The server's answer is final here too, but the reason goes to its log instead of a toast.
    const refused = setup();
    refused.api.jamUpload = answeredWith(new ApiClientError('http', 'x', 422, 'invalid_audio'));
    refused.uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    refused.feeds[0]?.push(HEAD);
    await settle();
    expect(refused.api.jamFetchDecline).toHaveBeenCalledWith(
      'sala-1',
      'a',
      'upload failed: invalid_audio',
    );
    expect(refused.api.jamUpload).toHaveBeenCalledTimes(1);
    expect(refused.api.jamRemove).not.toHaveBeenCalled();

    const timedOut = setup();
    timedOut.api.jamUpload = answeredWith(new ApiClientError('timeout', 'Demorou.'));
    timedOut.uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    timedOut.feeds[0]?.push(HEAD);
    await settle();
    expect(timedOut.api.jamFetchDecline).toHaveBeenCalledWith(
      'sala-1',
      'a',
      'upload failed: timeout',
    );

    const unexpected = setup();
    unexpected.api.jamUpload = answeredWith(new Error('boom'));
    unexpected.uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    unexpected.feeds[0]?.push(HEAD);
    await settle();
    expect(unexpected.api.jamFetchDecline).toHaveBeenCalledWith(
      'sala-1',
      'a',
      'unexpected failure',
    );
    expect(unexpected.statuses).toEqual([]);
  });

  it('has nothing to decline when the song is gone or already uploaded', async () => {
    const gone = setup();
    gone.api.jamUpload = answeredWith(new ApiClientError('http', 'x', 404, 'item_not_found'));
    gone.uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    gone.feeds[0]?.push(HEAD);
    await settle();
    expect(gone.api.jamFetchDecline).not.toHaveBeenCalled();
    expect(gone.api.jamRemove).not.toHaveBeenCalled();
    expect(gone.feeds[0]?.download.error?.reason).toBe('cancelled');
    expect(gone.uploads.isSending('4D7u5KF7SP8')).toBe(false);

    const already = setup();
    already.api.jamUpload = answeredWith(new ApiClientError('http', 'x', 409, 'already_uploaded'));
    already.uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    already.feeds[0]?.push(HEAD);
    await settle();
    expect(already.api.jamFetchDecline).not.toHaveBeenCalled();
    expect(already.api.jamRemove).not.toHaveBeenCalled();
    expect(already.uploads.isSending('4D7u5KF7SP8')).toBe(false);
  });

  it('lets a refused decline go (the song moved on, or the server is unreachable)', async () => {
    const { uploads, api, feeds, statuses } = setup();
    api.jamFetchDecline.mockRejectedValueOnce(
      new ApiClientError('http', 'x', 404, 'item_not_found'),
    );
    uploads.start('sala-1', jamItem('a'), { delegated: true });
    await settle();
    feeds[0]?.fail('blocked');
    await settle();
    api.jamFetchDecline.mockRejectedValueOnce(new ApiClientError('network', 'offline'));
    uploads.start('sala-1', jamItem('b'), { delegated: true });
    await settle();
    feeds[1]?.fail('network');
    await settle();
    expect(api.jamFetchDecline).toHaveBeenCalledTimes(2);
    expect(statuses).toEqual([]);
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(false);
  });

  it('stops when the song leaves the queue, telling nobody', async () => {
    const { uploads, feeds, store, statuses, api } = setup();
    const item = jamItem('a');
    store.apply({
      type: 'jam_snapshot',
      data: { available: true, rooms: { 'sala-1': inQueue(item) }, serverTime: 1 },
    });
    uploads.start('sala-1', item, { delegated: true });
    await settle();
    feeds[0]?.push(HEAD);
    await settle();
    store.apply({ type: 'jam_snapshot', data: { available: true, rooms: {}, serverTime: 2 } });
    await settle();
    expect(feeds[0]?.download.error?.reason).toBe('cancelled');
    expect(statuses).toEqual([]);
    expect(api.jamRemove).not.toHaveBeenCalled();
    // Gone already: there is nothing to decline.
    expect(api.jamFetchDecline).not.toHaveBeenCalled();
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(false);
  });

  it('hands its songs back to the server on logout or quit', async () => {
    const { uploads, feeds, statuses, api, slots } = setup();
    uploads.start('sala-1', jamItem('a'), { delegated: true });
    uploads.start('sala-1', jamItem('b', 'xxxxxxxxxxx'));
    await settle();
    feeds[0]?.push(HEAD);
    await settle();
    const before = statuses.length;
    uploads.cancelAll();
    await settle();
    expect(feeds.map((feed) => feed.download.error?.reason)).toEqual(['cancelled', 'cancelled']);
    // The delegated song is reassigned by the server; the app's own one is removed, as always.
    expect(api.jamFetchDecline).toHaveBeenCalledTimes(1);
    expect(api.jamFetchDecline).toHaveBeenCalledWith('sala-1', 'a', 'app stopped');
    expect(api.jamRemove).toHaveBeenCalledTimes(1);
    expect(api.jamRemove).toHaveBeenCalledWith('sala-1', 'b');
    expect(statuses).toHaveLength(before);
    expect(statuses.every((status) => status.itemId === 'b')).toBe(true);
    expect(uploads.list()).toEqual([]);
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(false);
    expect(slots.busy).toBe(0);
  });

  it('keeps out of the list, next to the app’s own songs', async () => {
    const { uploads, feeds, statuses } = setup();
    uploads.start('sala-1', jamItem('a'), { delegated: true });
    uploads.start('sala-1', jamItem('b', 'xxxxxxxxxxx'));
    expect(uploads.list().map((status) => status.itemId)).toEqual(['b']);
    expect(uploads.isSending('4D7u5KF7SP8')).toBe(true);
    expect(uploads.isSending('xxxxxxxxxxx')).toBe(true);
    await settle();
    finish(feeds[0], HEAD);
    finish(feeds[1], HEAD);
    await settle();
    expect(uploads.list()).toEqual([expect.objectContaining({ itemId: 'b', state: 'done' })]);
    expect(statuses.map((status) => status.itemId)).toEqual(['b', 'b', 'b']);
  });
});
