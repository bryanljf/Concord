/**
 * Background jobs that send the audio of the songs this app added to a jam. The audio streams:
 * the `PUT …/audio` starts as soon as yt-dlp's first bytes look like WebM and is fed as they
 * arrive (after the bytes a prefetch already had, when the song was prefetched), so the server can
 * start playing before the download ends. Statuses: `preparing` only while yt-dlp is being
 * fetched or updated → `downloading` while bytes still come from yt-dlp → `uploading` for the
 * tail still on its way after the download finished → `done` on the server's 204. The server's
 * answer is final, even one that comes while the body is still being sent (it drops the song for
 * everyone when its upload fails), so a request is sent again only when it never reached the
 * server. On failure the song is removed from the queue (best effort) and the job ends in
 * `error` with a pt-BR message. yt-dlp's processes are shared with the prefetches, jobs first
 * (`YtDlpSlots`); finished statuses are kept a few minutes for `getJamUploads`.
 *
 * Delegated jobs (`delegated: true`) send someone else's song, at the server's request (a client
 * without yt-dlp added it): the same pipeline, but silent: never listed, no status emitted, no
 * message for anyone; on failure the fetch is declined (the server asks another app) instead of
 * the song being removed.
 */
import type { JamItem, JamSnapshot, RoomId } from '@concord/shared';
import type { JamUploadStatus } from '../../preload/api';
import { ApiClientError, type ApiClient } from '../api-client';
import { log } from '../log';
import { UserFacingError } from '../validation';
import { delay, untilAborted } from './async';
import { JamDownloadError, type JamDownload } from './download';
import type { JamPrefetcher, PrefetchedAudio } from './prefetch';
import type { YtDlpSlots } from './slots';
import type { JamStore } from './store';
import { YtDlpError, type YtDlpManager } from './ytdlp';

const logger = log('jam-uploads');

/** `done` and `error` statuses are forgotten after this long. */
export const JAM_UPLOAD_STATUS_TTL_MS = 5 * 60 * 1000;
/** Wait before sending again an upload that never reached the server. */
export const JAM_UPLOAD_RETRY_DELAY_MS = 2_000;

export const JAM_ITEM_GONE_MESSAGE = 'A música saiu da fila antes de terminar o envio.';
export const JAM_UPLOAD_FAILED_MESSAGE = 'Não foi possível enviar a música para a Jam.';

export type JamUploadListener = (status: JamUploadStatus) => void;

export interface JamUploadStartOptions {
  /** The server asked for this song on someone else's behalf: silent, declined on failure. */
  delegated?: boolean;
}

export interface JamUploads {
  /** Starts sending `item`'s audio in the background (ignored when already known). */
  start(room: RoomId, item: JamItem, options?: JamUploadStartOptions): void;
  /** Whether a job is still sending `videoId` (prefetching it would be wasted). */
  isSending(videoId: string): boolean;
  /** Statuses of this app's own songs (delegated jobs are nobody's business here). */
  list(): JamUploadStatus[];
  onStatus(listener: JamUploadListener): () => void;
  /**
   * Stops every job (logout, quit), dropping their statuses; their songs are removed if
   * possible, and the delegated ones handed back to the server.
   */
  cancelAll(): void;
  destroy(): void;
}

export interface JamUploadsDeps {
  api: Pick<ApiClient, 'jamUpload' | 'jamRemove' | 'jamFetchDecline'>;
  ytdlp: Pick<YtDlpManager, 'ensure' | 'needsInstall'>;
  /** Starts yt-dlp for `videoId` (a process slot is held for it). */
  startDownload(exePath: string, videoId: string): JamDownload;
  slots: Pick<YtDlpSlots, 'acquire'>;
  /** Songs downloaded ahead of time: a job takes over the prefetch of its song. */
  prefetches?: Pick<JamPrefetcher, 'take'>;
  /** The jam state: a job whose song left the queue stops. */
  store: Pick<JamStore, 'get' | 'onEvent'>;
  statusTtlMs?: number;
  retryDelayMs?: number;
}

/** Abort reason of a job; `message` null = cancelled without a status (logout, quit). */
class JobAbort extends Error {
  override readonly name = 'JobAbort';
  constructor(readonly statusMessage: string | null) {
    super(statusMessage ?? 'cancelled');
  }
}

interface Job {
  status: JamUploadStatus;
  readonly videoId: string;
  /** Sent for the server (someone else's song): silent, declined instead of removed. */
  readonly delegated: boolean;
  readonly controller: AbortController;
  /** Seen in the jam state: from then on, missing from it means it left the queue. */
  seen: boolean;
  finished: boolean;
  expiry: NodeJS.Timeout | null;
}

function isInJam(snapshot: JamSnapshot, room: RoomId, itemId: string): boolean {
  const state = snapshot.rooms[room];
  if (!state) return false;
  return state.current?.item.id === itemId || state.queue.some((item) => item.id === itemId);
}

/** `stream`, calling `onRead` once when its first chunk is asked for (the request is under way). */
function noticingReads(
  stream: ReadableStream<Uint8Array>,
  onRead: () => void,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        onRead();
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
}

function failureMessage(err: unknown): string {
  if (err instanceof UserFacingError || err instanceof ApiClientError) return err.message;
  logger.error('unexpected jam upload failure', err);
  return JAM_UPLOAD_FAILED_MESSAGE;
}

/** What a delegated job tells the server when it gives up (its log only, never a UI). */
function declineReason(err: unknown): string {
  if (err instanceof JamDownloadError) return `download failed: ${err.reason}`;
  if (err instanceof YtDlpError) return 'yt-dlp unavailable';
  if (err instanceof ApiClientError) return `upload failed: ${err.code ?? err.kind}`;
  return 'unexpected failure';
}

export function createJamUploads(deps: JamUploadsDeps): JamUploads {
  const { api, ytdlp, store, slots } = deps;
  const statusTtlMs = deps.statusTtlMs ?? JAM_UPLOAD_STATUS_TTL_MS;
  const retryDelayMs = deps.retryDelayMs ?? JAM_UPLOAD_RETRY_DELAY_MS;
  const jobs = new Map<string, Job>();
  const listeners = new Set<JamUploadListener>();

  // --- Statuses ------------------------------------------------------------------------------
  function emit(job: Job): void {
    if (job.delegated) return;
    const status = { ...job.status };
    for (const listener of listeners) listener(status);
  }

  function setState(job: Job, state: JamUploadStatus['state']): void {
    if (job.finished || job.status.state === state) return;
    job.status = { ...job.status, state };
    emit(job);
  }

  function finish(job: Job, state: 'done' | 'error', message: string | null): void {
    if (job.finished) return;
    job.status = { ...job.status, state, message };
    job.finished = true;
    emit(job);
    job.expiry = setTimeout(() => {
      if (jobs.get(job.status.itemId) === job) jobs.delete(job.status.itemId);
    }, statusTtlMs);
    job.expiry.unref?.();
  }

  // --- The job -------------------------------------------------------------------------------
  function removeQuietly(room: RoomId, itemId: string): void {
    api.jamRemove(room, itemId).catch((err: unknown) => {
      logger.warn(`could not remove jam item ${itemId} after its failure`, err);
    });
  }

  /** Hands a delegated song back to the server (which asks another app). */
  function declineQuietly(room: RoomId, itemId: string, reason: string): void {
    api.jamFetchDecline(room, itemId, reason).catch((err: unknown) => {
      // Gone, or already handed to someone else: nothing left to decline.
      if (err instanceof ApiClientError && err.code === 'item_not_found') return;
      logger.warn(`could not decline the fetch of jam item ${itemId}`, err);
    });
  }

  /** Starts yt-dlp for `videoId` once a process slot is free (jobs go before prefetches). */
  async function launch(
    exePath: string,
    videoId: string,
    signal: AbortSignal,
  ): Promise<JamDownload> {
    const slot = await slots.acquire('job', signal);
    if (signal.aborted) {
      slot.release();
      throw signal.reason;
    }
    let download: JamDownload;
    try {
      download = deps.startDownload(exePath, videoId);
    } catch (err) {
      slot.release();
      throw err;
    }
    const release = (): void => slot.release();
    download.exited.then(release, release);
    return download;
  }

  /**
   * Streams `audio` to the server. Its answer is final, even an early one; only a request that
   * never reached it (refused before its body was read) is sent once more, from the first byte.
   */
  async function send(job: Job, room: RoomId, itemId: string, audio: JamDownload): Promise<void> {
    const { signal } = job.controller;
    const request = { reached: false };
    const attempt = async (): Promise<void> => {
      const body = noticingReads(audio.stream(), () => {
        request.reached = true;
      });
      try {
        await untilAborted(api.jamUpload(room, itemId, body, signal), signal);
      } catch (err) {
        // The body broke because the download failed: that is what went wrong.
        throw audio.error ?? err;
      }
    };
    try {
      await attempt();
    } catch (err) {
      if (signal.aborted || request.reached) throw err;
      if (!(err instanceof ApiClientError) || err.kind !== 'network') throw err;
      logger.warn(`upload of ${itemId} never reached the server (${err.message}); trying again`);
      await delay(retryDelayMs, signal);
      if (audio.error) throw audio.error;
      setState(job, audio.state === 'running' ? 'downloading' : 'uploading');
      await attempt();
    }
  }

  async function run(
    job: Job,
    room: RoomId,
    item: JamItem,
    prefetched: PrefetchedAudio | null,
  ): Promise<void> {
    const { signal } = job.controller;
    const { videoId } = item.track;
    const onPreparing = (): void => setState(job, 'preparing');
    const startedAt = Date.now();
    let download = prefetched?.download ?? null;
    try {
      let revision = prefetched?.revision ?? null;
      if (!download) {
        const binary = await untilAborted(ytdlp.ensure({ onPreparing }), signal);
        revision = binary.revision;
        setState(job, 'downloading');
        download = await launch(binary.path, videoId, signal);
      }
      try {
        await untilAborted(download.started, signal);
      } catch (err) {
        if (signal.aborted || !(err instanceof JamDownloadError) || !err.maybeOutdated) throw err;
        // YouTube changes often break yt-dlp until its next release: update once and retry.
        // Nothing was sent yet (these failures come before the first byte).
        logger.info(`download of ${videoId} failed like an outdated yt-dlp; checking for updates`);
        const updated = await untilAborted(ytdlp.ensure({ force: true, onPreparing }), signal);
        if (updated.revision === revision) throw err;
        setState(job, 'downloading');
        download = await launch(updated.path, videoId, signal);
        await untilAborted(download.started, signal);
      }
      const audio = download;
      const tail = (): void => setState(job, 'uploading');
      audio.finished.then(tail, () => undefined);
      await send(job, room, item.id, audio);
      logger.info(
        `jam item ${item.id} sent (${audio.size} bytes, ${Date.now() - startedAt} ms after it was added)`,
      );
      finish(job, 'done', null);
    } catch (err) {
      if (signal.aborted) {
        const reason: unknown = signal.reason;
        const message = reason instanceof JobAbort ? reason.statusMessage : null;
        logger.info(`jam item ${item.id} stopped${message ? `: ${message}` : ''}`);
        if (message !== null) finish(job, 'error', message);
        return;
      }
      if (err instanceof ApiClientError && err.code === 'already_uploaded') {
        finish(job, 'done', null);
        return;
      }
      const gone = err instanceof ApiClientError && err.code === 'item_not_found';
      if (!gone) {
        // Someone else's song (delegated): the server asks another app instead of dropping it.
        if (job.delegated) declineQuietly(room, item.id, declineReason(err));
        else removeQuietly(room, item.id);
      }
      const message = gone ? JAM_ITEM_GONE_MESSAGE : failureMessage(err);
      logger.warn(`jam item ${item.id} (${videoId}) failed: ${message}`);
      finish(job, 'error', message);
    } finally {
      // A download nobody needs anymore (failure, song gone, logout) stops here.
      if (download?.state === 'running') download.cancel();
    }
  }

  const unsubscribe = store.onEvent(() => {
    const snapshot = store.get();
    // Disconnected: nothing is known about the queue until the next snapshot.
    if (!snapshot.available) return;
    for (const job of jobs.values()) {
      if (job.finished) continue;
      if (isInJam(snapshot, job.status.room, job.status.itemId)) job.seen = true;
      else if (job.seen) job.controller.abort(new JobAbort(JAM_ITEM_GONE_MESSAGE));
    }
  });

  return {
    start(room, item, options = {}) {
      if (jobs.has(item.id)) return;
      const delegated = options.delegated === true;
      const { videoId } = item.track;
      const prefetched = deps.prefetches?.take(videoId) ?? null;
      let state: JamUploadStatus['state'];
      if (prefetched)
        state = prefetched.download.state === 'complete' ? 'uploading' : 'downloading';
      else state = ytdlp.needsInstall() ? 'preparing' : 'downloading';
      const job: Job = {
        status: { itemId: item.id, room, title: item.track.title, state, message: null },
        videoId,
        delegated,
        controller: new AbortController(),
        seen: isInJam(store.get(), room, item.id),
        finished: false,
        expiry: null,
      };
      jobs.set(item.id, job);
      logger.info(
        `sending the audio of jam item ${item.id} (${videoId}) to ${room}${delegated ? ' for the server' : ''}${prefetched ? ` (prefetched: ${prefetched.download.size} bytes so far)` : ''}`,
      );
      emit(job);
      void run(job, room, item, prefetched);
    },
    isSending: (videoId) =>
      [...jobs.values()].some((job) => !job.finished && job.videoId === videoId),
    list: () =>
      [...jobs.values()].filter((job) => !job.delegated).map((job) => ({ ...job.status })),
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancelAll() {
      for (const job of jobs.values()) {
        if (job.expiry) clearTimeout(job.expiry);
        if (!job.finished) {
          job.finished = true;
          job.controller.abort(new JobAbort(null));
          // Otherwise the song would wait for the server's upload timeout (a delegated one is
          // handed to another app right away instead).
          if (job.delegated) declineQuietly(job.status.room, job.status.itemId, 'app stopped');
          else removeQuietly(job.status.room, job.status.itemId);
        }
      }
      jobs.clear();
    },
    destroy() {
      unsubscribe();
    },
  };
}
