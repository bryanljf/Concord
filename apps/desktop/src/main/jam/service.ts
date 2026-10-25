/**
 * What the IPC layer calls for the Jam: the rooms' jams (from the presence SSE), YouTube Music
 * search, adding a song (and sending its audio in the background when the server asks for it),
 * prefetching the songs about to be added, and the controls anyone in the room may use.
 * Electron-free: `index.ts` wires the real parts.
 */
import type {
  JamEvent,
  JamItem,
  JamRecentTrack,
  JamSnapshot,
  JamTrack,
  RoomId,
} from '@concord/shared';
import type { JamUploadStatus, Session } from '../../preload/api';
import { ApiClientError, type ApiClient } from '../api-client';
import { log } from '../log';
import { UserFacingError } from '../validation';
import type { JamPrefetcher } from './prefetch';
import type { JamStore } from './store';
import type { JamUploads } from './uploads';

const logger = log('jam');

export const JAM_PLATFORM_UNSUPPORTED_MESSAGE =
  'Por enquanto só dá para adicionar músicas à Jam no Windows.';

export interface JamService {
  getState(): JamSnapshot;
  onEvent(listener: (event: JamEvent) => void): () => void;
  /** Searches, then starts prefetching the top result (unless the server already has it). */
  search(query: string): Promise<JamTrack[]>;
  /**
   * Starts downloading these songs ahead of time (Windows only, while the jam is available),
   * skipping those the server already has or this app is already sending.
   */
  prefetch(videoIds: readonly string[]): void;
  /** "Recentes": the songs the server still has (so never prefetched while they are listed). */
  recent(): Promise<JamRecentTrack[]>;
  /** Enqueues and resolves with the item; its audio is sent in the background when needed. */
  add(room: RoomId, videoId: string): Promise<JamItem>;
  remove(room: RoomId, itemId: string): Promise<void>;
  skip(room: RoomId, itemId: string): Promise<void>;
  /** Moves `itemId` to `positionMs` for everyone; a no-op once it is no longer the one playing. */
  seek(room: RoomId, itemId: string, positionMs: number): Promise<void>;
  /**
   * Plays the previous song, `itemId` being the one playing (null: none); a no-op once that
   * changed, so two quick presses go back one song.
   */
  previous(room: RoomId, itemId: string | null): Promise<void>;
  pause(room: RoomId): Promise<void>;
  resume(room: RoomId): Promise<void>;
  getUploads(): JamUploadStatus[];
  onUploadStatus(listener: (status: JamUploadStatus) => void): () => void;
  /** Stops the uploads and prefetches in progress (logout, another account or server, quit). */
  cancelUploads(): void;
  destroy(): void;
}

export interface JamServiceDeps {
  api: Pick<
    ApiClient,
    | 'jamSearch'
    | 'jamRecent'
    | 'jamEnqueue'
    | 'jamRemove'
    | 'jamSkip'
    | 'jamSeek'
    | 'jamPrevious'
    | 'jamPause'
    | 'jamResume'
  >;
  store: JamStore;
  uploads: JamUploads;
  /** Downloads ahead of time; none: no prefetching. */
  prefetches?: Pick<JamPrefetcher, 'prefetch' | 'discard' | 'clear'>;
  /** yt-dlp runs here (Windows only). */
  canDownload: boolean;
  /** Gets yt-dlp ready ahead of time; called after a search, since adding a song usually follows. */
  prepare?: () => void;
}

/** Who the uploads belong to: they stop when this changes (null = logged out). */
export function jamSessionOwner(session: Session): string | null {
  return session.user ? `${session.user.id}@${session.serverUrl}` : null;
}

function hasCode(err: unknown, ...codes: string[]): boolean {
  return err instanceof ApiClientError && err.code !== undefined && codes.includes(err.code);
}

/** A song of some room's jam whose audio the server stores already. */
function serverHas(snapshot: JamSnapshot, videoId: string): boolean {
  return Object.values(snapshot.rooms).some((state) =>
    [state.current?.item, ...state.queue].some(
      (item) => item?.track.videoId === videoId && item.status === 'ready',
    ),
  );
}

export function createJamService(deps: JamServiceDeps): JamService {
  const { api, store, uploads, prefetches, canDownload } = deps;
  /** What the last search said the server already has: adding those needs no download. */
  let cached: ReadonlySet<string> = new Set();
  /** The server's cache as "Recentes" last listed it: no download needed for those either. */
  let recentlyCached: ReadonlySet<string> = new Set();

  function prefetch(videoIds: readonly string[]): void {
    if (!prefetches || !canDownload) return;
    const snapshot = store.get();
    if (!snapshot.available) return;
    const wanted = videoIds.filter(
      (videoId) =>
        !cached.has(videoId) &&
        !recentlyCached.has(videoId) &&
        !uploads.isSending(videoId) &&
        !serverHas(snapshot, videoId),
    );
    if (wanted.length > 0) prefetches.prefetch(wanted);
  }

  // No jam, nothing to prefetch for.
  const unsubscribe = store.onEvent(() => {
    if (!store.get().available) prefetches?.clear();
  });

  return {
    getState: () => store.snapshotNow(),
    onEvent: (listener) => store.onEvent(listener),
    async search(query) {
      const { results, cached: known } = await api.jamSearch(query);
      cached = new Set(known);
      if (canDownload) {
        deps.prepare?.();
        // The top result is the likeliest pick: have it ready before the click.
        const top = results[0];
        if (top) prefetch([top.videoId]);
      }
      return results;
    },
    prefetch,
    async recent() {
      const tracks = await api.jamRecent();
      recentlyCached = new Set(tracks.map((track) => track.videoId));
      return tracks;
    },
    async add(room, videoId) {
      if (!canDownload) throw new UserFacingError(JAM_PLATFORM_UNSUPPORTED_MESSAGE);
      const { item, upload } = await api.jamEnqueue(room, videoId);
      logger.info(`added ${videoId} to ${room} as ${item.id}${upload ? ' (sending audio)' : ''}`);
      if (upload) uploads.start(room, item);
      else prefetches?.discard(videoId);
      return item;
    },
    async remove(room, itemId) {
      try {
        await api.jamRemove(room, itemId);
      } catch (err) {
        // Someone removed it first (or it finished playing): the goal is met.
        if (!hasCode(err, 'item_not_found')) throw err;
      }
    },
    async skip(room, itemId) {
      try {
        await api.jamSkip(room, itemId);
      } catch (err) {
        // Someone skipped it first, or it ended: never skip the next song by accident.
        if (!hasCode(err, 'stale', 'item_not_found')) throw err;
      }
    },
    async seek(room, itemId, positionMs) {
      try {
        await api.jamSeek(room, itemId, positionMs);
      } catch (err) {
        // The song changed meanwhile (skipped, ended): never move the next one by accident.
        if (!hasCode(err, 'stale', 'item_not_found')) throw err;
      }
    },
    async previous(room, itemId) {
      try {
        await api.jamPrevious(room, itemId);
      } catch (err) {
        // Someone went back or skipped first: never go back two songs by accident.
        if (!hasCode(err, 'stale')) throw err;
      }
    },
    pause: (room) => api.jamPause(room),
    resume: (room) => api.jamResume(room),
    getUploads: () => uploads.list(),
    onUploadStatus: (listener) => uploads.onStatus(listener),
    cancelUploads() {
      uploads.cancelAll();
      prefetches?.clear();
    },
    destroy() {
      unsubscribe();
      uploads.cancelAll();
      uploads.destroy();
      prefetches?.clear();
    },
  };
}
