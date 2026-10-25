/**
 * Songs downloaded before anyone adds them, so that adding one is near-instant: the top result of
 * each search and whatever the renderer points at (a hovered or focused result, a pasted link).
 * Memory only: at most `JAM_PREFETCH_MAX` songs (the least recently requested is dropped first),
 * each dropped `JAM_PREFETCH_TTL_MS` after it was last requested unless its song gets added — the
 * upload job then takes the download over where it is (`take`), never starting it again.
 * Prefetches share the yt-dlp processes with the upload jobs and always yield to them
 * (`YtDlpSlots`). Dropping one kills its process tree, and its temp folder goes with it. A
 * prefetch that failed stays as such until it expires, so pointing at it again does not retry.
 * Electron-free; the service decides when prefetching makes sense (Windows, jam available, the
 * server does not have the song).
 */
import { log } from '../log';
import { untilAborted } from './async';
import type { JamDownload } from './download';
import type { YtDlpSlot, YtDlpSlots } from './slots';
import type { YtDlpManager } from './ytdlp';

const logger = log('jam-prefetch');

/** Songs held at once (each up to `JAM_UPLOAD_MAX_BYTES`, typically 3 to 6 MB). */
export const JAM_PREFETCH_MAX = 3;
/** A song not requested again (nor added) for this long is dropped. */
export const JAM_PREFETCH_TTL_MS = 3 * 60 * 1000;

export type JamPrefetchState = 'pending' | 'running' | 'complete' | 'failed';

/** A prefetch handed over to the upload job of its song. */
export interface PrefetchedAudio {
  download: JamDownload;
  /** Revision of the yt-dlp that runs it (a forced update must change it to be worth a retry). */
  revision: number;
}

export interface JamPrefetcher {
  /** Starts (or keeps) downloading these songs; the first one counts as the most recent. */
  prefetch(videoIds: readonly string[]): void;
  /** Hands `videoId`'s download over to an upload job; null when none is worth taking. */
  take(videoId: string): PrefetchedAudio | null;
  /** Drops `videoId` (it turned out the server has it). */
  discard(videoId: string): void;
  /** The songs held, most recently requested first. */
  list(): { videoId: string; state: JamPrefetchState; size: number }[];
  /** Drops everything (logout, jam unavailable, quit). */
  clear(): void;
}

export interface JamPrefetcherDeps {
  ytdlp: Pick<YtDlpManager, 'ensure'>;
  slots: Pick<YtDlpSlots, 'acquire'>;
  /** Starts yt-dlp for `videoId` (a process slot is held for it). */
  startDownload(exePath: string, videoId: string): JamDownload;
  maxEntries?: number;
  ttlMs?: number;
}

interface Entry {
  readonly videoId: string;
  readonly controller: AbortController;
  state: JamPrefetchState;
  download: JamDownload | null;
  slot: YtDlpSlot | null;
  revision: number;
  timer: NodeJS.Timeout | null;
  /** Handed over to an upload job: no longer this module's business. */
  taken: boolean;
}

export function createJamPrefetcher(deps: JamPrefetcherDeps): JamPrefetcher {
  const { ytdlp, slots } = deps;
  const maxEntries = deps.maxEntries ?? JAM_PREFETCH_MAX;
  const ttlMs = deps.ttlMs ?? JAM_PREFETCH_TTL_MS;
  /** In request order: the first one is the least recently requested. */
  const entries = new Map<string, Entry>();

  function arm(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => drop(entry, 'not requested for a while'), ttlMs);
    entry.timer.unref?.();
  }

  function drop(entry: Entry, why: string): void {
    if (entries.get(entry.videoId) !== entry) return;
    entries.delete(entry.videoId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.controller.abort();
    // Kills its process tree; the slot and the temp folder are released once it is gone.
    if (entry.download?.state === 'running') entry.download.cancel();
    entry.download = null;
    logger.info(`dropped the prefetch of ${entry.videoId} (${why})`);
  }

  async function run(entry: Entry): Promise<void> {
    const { signal } = entry.controller;
    try {
      const binary = await untilAborted(ytdlp.ensure(), signal);
      const slot = await slots.acquire('prefetch', signal, () =>
        drop(entry, 'an added song needed its yt-dlp'),
      );
      if (signal.aborted) {
        slot.release();
        return;
      }
      let download: JamDownload;
      try {
        download = deps.startDownload(binary.path, entry.videoId);
      } catch (err) {
        slot.release();
        throw err;
      }
      const release = (): void => slot.release();
      download.exited.then(release, release);
      entry.slot = slot;
      entry.download = download;
      entry.revision = binary.revision;
      entry.state = 'running';
      logger.info(`prefetching ${entry.videoId}`);
      await download.finished;
      if (entry.taken) return;
      entry.state = 'complete';
      logger.info(`prefetched ${entry.videoId} (${download.size} bytes)`);
    } catch (err) {
      if (signal.aborted || entry.taken) return;
      entry.state = 'failed';
      entry.download = null;
      logger.info(
        `prefetch of ${entry.videoId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    prefetch(videoIds) {
      const requested = [...new Set(videoIds)].slice(0, maxEntries);
      /** The new ones, in request order. */
      const fresh: Entry[] = [];
      // Last touched = most recent: the first id goes last.
      for (const videoId of [...requested].reverse()) {
        const known = entries.get(videoId);
        if (known) {
          entries.delete(videoId);
          entries.set(videoId, known);
          arm(known);
          continue;
        }
        const entry: Entry = {
          videoId,
          controller: new AbortController(),
          state: 'pending',
          download: null,
          slot: null,
          revision: 0,
          timer: null,
          taken: false,
        };
        entries.set(videoId, entry);
        arm(entry);
        fresh.unshift(entry);
      }
      for (const entry of [...entries.values()]) {
        if (entries.size <= maxEntries) break;
        drop(entry, 'too many prefetches');
      }
      // The first one requested starts first.
      for (const entry of fresh) void run(entry);
    },
    take(videoId) {
      const entry = entries.get(videoId);
      if (!entry) return null;
      const { download, slot } = entry;
      if (!download || !slot || download.state === 'failed') {
        // Not started yet (or failed): the job downloads it on its own, first in line.
        drop(entry, 'added before it could help');
        return null;
      }
      entries.delete(videoId);
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.taken = true;
      slot.promote();
      logger.info(`${videoId} was added: its prefetch goes on (${download.size} bytes so far)`);
      return { download, revision: entry.revision };
    },
    discard(videoId) {
      const entry = entries.get(videoId);
      if (entry) drop(entry, 'the server has it');
    },
    list: () =>
      [...entries.values()].reverse().map((entry) => ({
        videoId: entry.videoId,
        state: entry.state,
        size: entry.download?.size ?? 0,
      })),
    clear() {
      for (const entry of [...entries.values()]) drop(entry, 'cleared');
    },
  };
}
