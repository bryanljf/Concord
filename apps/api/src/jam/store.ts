import { randomUUID } from 'node:crypto';
import {
  isJamEmpty,
  JAM_HISTORY_MAX,
  JAM_QUEUE_MAX,
  JAM_UPLOAD_TIMEOUT_MS,
  jamPositionAt,
  type JamItem,
  type JamNowPlaying,
  type JamSnapshot,
  type JamState,
  type JamTrack,
  type RoomId,
} from '@concord/shared';
import { JamError } from './errors';

/** A seek to within this of where the song already is changes nothing. */
export const JAM_SEEK_TOLERANCE_MS = 250;

/** A room's jam as the store keeps (and always sends) it: with its history. */
type RoomJam = JamState & { history: JamItem[] };

function emptyJam(room: RoomId): RoomJam {
  return { room, current: null, queue: [], history: [] };
}

/** The desktop app asked to download a song for a requester who cannot (the web client). */
export interface PendingFetcher {
  userId: string;
  /** The presence connection the request went to (gone: the app disconnected). */
  connectionId: string;
  /** Server clock: when it was asked. */
  assignedAt: number;
}

/**
 * The audio of a song nobody has sent yet. One per videoId (the cache is shared by every room):
 * the first item that needs it uploads it, later duplicates (in any room) wait for the same file.
 * It outlives its own item while duplicates still wait, so removing the first copy does not strand
 * the others.
 */
export interface PendingUpload {
  videoId: string;
  /** The item whose requester's app (or assigned fetcher) sends the audio. */
  itemId: string;
  room: RoomId;
  requestedBy: string;
  /** Server clock: when the items still waiting for it leave the queue. */
  deadline: number;
  /** An upload is being received right now. */
  receiving: boolean;
  /**
   * The app asked to download it in the requester's stead; null while the requester's own app is
   * expected to (or, for a delegated song restored from the state file, until the sweep asks
   * someone again).
   */
  fetcher: PendingFetcher | null;
  /** How many apps were asked so far: 0 means the requester uploads it themselves. */
  assignments: number;
  /** Users already asked (each is asked once per song). */
  tried: string[];
}

export interface JamUpdate {
  type: 'jam_updated';
  state: JamState;
  serverTime: number;
}

export type JamStoreListener = (update: JamUpdate) => void;

/** What `JAM_STATE_FILE` holds. */
export interface PersistedJam {
  version: 1;
  rooms: JamState[];
  uploads: PendingUpload[];
}

/**
 * `data` without the ready songs (playing, queued or in the history) of `videoIds`: their audio is
 * not on disk (an upload still streaming when the api stopped). Songs waiting for an upload stay.
 */
export function withoutReadySongs(data: PersistedJam, videoIds: ReadonlySet<string>): PersistedJam {
  return {
    ...data,
    rooms: data.rooms.map((state) => ({
      room: state.room,
      current:
        state.current && videoIds.has(state.current.item.track.videoId) ? null : state.current,
      queue: state.queue.filter(
        (item) => item.status !== 'ready' || !videoIds.has(item.track.videoId),
      ),
      history: (state.history ?? []).filter((item) => !videoIds.has(item.track.videoId)),
    })),
  };
}

function copyUpload(upload: PendingUpload): PendingUpload {
  return { ...upload, fetcher: upload.fetcher && { ...upload.fetcher }, tried: [...upload.tried] };
}

export interface EnqueueResult {
  item: JamItem;
  /** True when this requester's app must upload the audio. */
  upload: boolean;
}

export interface JamStoreOptions {
  now?: () => number;
  newId?: () => string;
  /** How long a song may wait for its audio (default JAM_UPLOAD_TIMEOUT_MS). */
  uploadTimeoutMs?: number;
  /** A song just entered a room's history (the service marks its audio as just used). */
  onHistory?: (videoId: string) => void;
  /** A song just started playing in a room (not when a saved jam is loaded). */
  onStart?: (item: JamItem) => void;
}

/**
 * The jam of every room: what plays, what comes next and what already played, in memory and
 * without I/O. Each change emits one `jam_updated` per room it touched, with the room's whole
 * state (history included, always).
 *
 * Playback always moves to the first `ready` song in queue order: songs still waiting for their
 * audio keep their place and play once they are ready. A new song always starts playing, even
 * when the previous one was paused. A song that played to its end or was skipped goes to the
 * front of the room's history ("Música anterior" plays it again), which lasts as long as the jam:
 * once nothing plays nor is queued, the room remains with its history until the service's linger
 * period ends the session.
 */
export class JamStore {
  private readonly rooms = new Map<RoomId, RoomJam>();
  private readonly uploads = new Map<string, PendingUpload>();
  private readonly listeners = new Set<JamStoreListener>();
  private readonly touched = new Set<RoomId>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly uploadTimeoutMs: number;
  private readonly onHistory: (videoId: string) => void;
  private readonly onStart: (item: JamItem) => void;

  constructor(options: JamStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? JAM_UPLOAD_TIMEOUT_MS;
    this.onHistory = options.onHistory ?? (() => undefined);
    this.onStart = options.onStart ?? (() => undefined);
  }

  subscribe(listener: JamStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------
  // Reads (always copies)
  // -------------------------------------------------------------------------

  state(room: RoomId): JamState {
    return structuredClone(this.rooms.get(room) ?? emptyJam(room));
  }

  current(room: RoomId): JamNowPlaying | null {
    const current = this.rooms.get(room)?.current;
    return current ? structuredClone(current) : null;
  }

  isEmpty(room: RoomId): boolean {
    return !this.rooms.has(room);
  }

  /** Whether the room has no current song or queued song, including a session with history only. */
  isIdle(room: RoomId): boolean {
    const state = this.rooms.get(room);
    return state === undefined || (state.current === null && state.queue.length === 0);
  }

  /** Rooms with something playing, queued, or retained in the current session history. */
  activeRooms(): RoomId[] {
    return [...this.rooms.keys()];
  }

  snapshot(available: boolean): JamSnapshot {
    const rooms: Record<RoomId, JamState> = {};
    for (const [room, state] of this.rooms) rooms[room] = structuredClone(state);
    return { available, rooms, serverTime: this.now() };
  }

  /** The item, playing or queued. */
  item(room: RoomId, itemId: string): JamItem | undefined {
    const state = this.rooms.get(room);
    const item =
      state?.current?.item.id === itemId
        ? state.current.item
        : state?.queue.find((queued) => queued.id === itemId);
    return item ? structuredClone(item) : undefined;
  }

  /** How some room describes `videoId` (playing, queued or in its history), if any does. */
  track(videoId: string): JamTrack | undefined {
    for (const state of this.rooms.values()) {
      const items = [
        ...(state.current ? [state.current.item] : []),
        ...state.queue,
        ...state.history,
      ];
      const found = items.find((item) => item.track.videoId === videoId);
      if (found) return { ...found.track };
    }
    return undefined;
  }

  /**
   * Every videoId some room still plays, queues or may play again from its history (their files
   * must stay in the cache).
   */
  referencedVideoIds(): Set<string> {
    const ids = new Set<string>();
    for (const state of this.rooms.values()) {
      if (state.current) ids.add(state.current.item.track.videoId);
      for (const item of [...state.queue, ...state.history]) ids.add(item.track.videoId);
    }
    return ids;
  }

  pendingUploads(): PendingUpload[] {
    return [...this.uploads.values()].map(copyUpload);
  }

  /** Whether a song's audio is still awaited (so another copy waits for the same upload). */
  awaits(videoId: string): boolean {
    return this.uploads.has(videoId);
  }

  /** The upload `itemId` (of `room`) is the item of, if still awaited. */
  uploadOf(room: RoomId, itemId: string): PendingUpload | undefined {
    const upload = this.findUpload(room, itemId);
    return upload ? copyUpload(upload) : undefined;
  }

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  /** Rejects with `queue_full` when the room cannot take another song. */
  assertQueueNotFull(room: RoomId): void {
    if ((this.rooms.get(room)?.queue.length ?? 0) >= JAM_QUEUE_MAX)
      throw new JamError('queue_full');
  }

  /**
   * Adds a song to the end of the queue. `cached`: its audio is already on the server, so it is
   * ready (and starts right away when nothing plays). Otherwise it waits for an upload: the
   * first item of that videoId gets `upload: true`, later ones wait for the same file.
   */
  enqueue(room: RoomId, track: JamTrack, requestedBy: string, cached: boolean): EnqueueResult {
    this.assertQueueNotFull(room);
    const now = this.now();
    const item: JamItem = {
      id: this.newId(),
      track: { ...track },
      requestedBy,
      addedAt: now,
      status: cached ? 'ready' : 'downloading',
    };
    const upload = !cached && !this.uploads.has(track.videoId);
    if (upload) {
      this.uploads.set(track.videoId, {
        videoId: track.videoId,
        itemId: item.id,
        room,
        requestedBy,
        deadline: now + this.uploadTimeoutMs,
        receiving: false,
        fetcher: null,
        assignments: 0,
        tried: [],
      });
    }
    const state = this.ensure(room);
    state.queue.push(item);
    this.touch(room);
    if (!state.current) this.startNext(room);
    this.flush();
    return { item: structuredClone(item), upload };
  }

  /**
   * Removes a song. The one playing is skipped (playback moves on); an upcoming one just leaves
   * the queue. Rejects with `item_not_found`.
   */
  remove(room: RoomId, itemId: string): void {
    const state = this.rooms.get(room);
    if (state?.current?.item.id === itemId) {
      this.advance(room);
    } else {
      const index = state?.queue.findIndex((item) => item.id === itemId) ?? -1;
      if (!state || index < 0) throw new JamError('item_not_found');
      state.queue.splice(index, 1);
      this.touch(room);
      this.forgetUnwantedUploads();
    }
    this.flush();
  }

  /** Skips the song playing, only if it still is `itemId`; rejects with `stale` otherwise. */
  skip(room: RoomId, itemId: string): void {
    if (this.rooms.get(room)?.current?.item.id !== itemId) throw new JamError('stale');
    this.advance(room);
    this.flush();
  }

  /**
   * The bot is done with `itemId`: it played it to the end (`ended`, remembered in the history) or
   * gave up on it (`failed`). Playback moves on.
   */
  finish(room: RoomId, itemId: string, outcome: 'ended' | 'failed' = 'ended'): boolean {
    if (this.rooms.get(room)?.current?.item.id !== itemId) return false;
    this.advance(room, outcome === 'ended');
    this.flush();
    return true;
  }

  /** Empties the room (nobody there anymore). */
  clear(room: RoomId): void {
    if (!this.rooms.has(room)) return;
    this.rooms.delete(room);
    this.touch(room);
    this.forgetUnwantedUploads();
    this.flush();
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  /** Pauses for everyone, freezing the position; a no-op when nothing plays or it is paused. */
  pause(room: RoomId, userId: string): void {
    const current = this.rooms.get(room)?.current;
    if (!current || current.paused) return;
    const now = this.now();
    current.positionMs = jamPositionAt(current, now);
    current.at = now;
    current.paused = true;
    current.pausedBy = userId;
    this.touch(room);
    this.flush();
  }

  /** Resumes from where it was paused; a no-op when nothing is paused. */
  resume(room: RoomId): void {
    const current = this.rooms.get(room)?.current;
    if (!current || !current.paused) return;
    current.at = this.now();
    current.paused = false;
    current.pausedBy = null;
    this.touch(room);
    this.flush();
  }

  /**
   * Moves the song playing to `positionMs` (clamped to the song), paused or not, only if it still
   * is `itemId` (rejects with `stale` otherwise). False, changing nothing, when it already is
   * within JAM_SEEK_TOLERANCE_MS of there.
   */
  seek(room: RoomId, itemId: string, positionMs: number): boolean {
    const current = this.rooms.get(room)?.current;
    if (!current || current.item.id !== itemId) throw new JamError('stale');
    if (!Number.isFinite(positionMs)) return false;
    const duration = current.item.track.durationMs;
    const target = Math.round(
      Math.max(0, duration > 0 ? Math.min(duration, positionMs) : positionMs),
    );
    const now = this.now();
    if (Math.abs(target - jamPositionAt(current, now)) < JAM_SEEK_TOLERANCE_MS) return false;
    current.positionMs = target;
    current.at = now;
    this.touch(room);
    this.flush();
    return true;
  }

  /**
   * Where the bot says `itemId` is, `paused` or playing, right now. Ignored unless it is still the
   * song playing in the same paused state (otherwise the bot is about to be told otherwise).
   */
  setPosition(room: RoomId, itemId: string, positionMs: number, paused: boolean): void {
    const current = this.rooms.get(room)?.current;
    if (!current || current.item.id !== itemId || current.paused !== paused) return;
    if (!Number.isFinite(positionMs) || positionMs < 0) return;
    current.positionMs = Math.round(positionMs);
    current.at = this.now();
    this.touch(room);
    this.flush();
  }

  // -------------------------------------------------------------------------
  // History ("Música anterior")
  // -------------------------------------------------------------------------

  /**
   * The song "Música anterior" would play: the latest of the history, provided the song playing
   * still is `itemId` (null: nothing plays). Rejects with `stale` or `no_previous`.
   */
  previousOf(room: RoomId, itemId: string | null): JamItem {
    const state = this.rooms.get(room);
    if ((state?.current?.item.id ?? null) !== itemId) throw new JamError('stale');
    const previous = state?.history[0];
    if (!previous) throw new JamError('no_previous');
    return structuredClone(previous);
  }

  /**
   * Plays `previousId`, the latest song of the history, from the start (leaving the history); the
   * song playing goes back to the front of the queue, so skipping returns to it. Only while the
   * song playing still is `itemId` and the history still starts with `previousId`; rejects with
   * `stale` otherwise.
   */
  playPrevious(room: RoomId, itemId: string | null, previousId: string): void {
    const state = this.rooms.get(room);
    const previous = state?.history[0];
    if (!state || !previous || previous.id !== previousId) throw new JamError('stale');
    if ((state.current?.item.id ?? null) !== itemId) throw new JamError('stale');
    state.history.shift();
    if (state.current) state.queue.unshift(state.current.item);
    state.current = this.nowPlaying(previous);
    this.onStart(previous);
    this.touch(room);
    this.flush();
  }

  /** Forgets a song of `room`'s history (its audio is gone). */
  forgetPrevious(room: RoomId, itemId: string): void {
    const state = this.rooms.get(room);
    const index = state?.history.findIndex((item) => item.id === itemId) ?? -1;
    if (!state || index < 0) return;
    state.history.splice(index, 1);
    this.touch(room);
    this.flush();
  }

  // -------------------------------------------------------------------------
  // Uploads
  // -------------------------------------------------------------------------

  /**
   * Claims the upload of `itemId` for `userId`: its requester, or the fetcher asked to download
   * it. Rejects with `item_not_found` (neither queued nor awaited), `not_requester` or
   * `already_uploaded` (ready, waiting for someone else's upload, or being received already).
   */
  beginUpload(room: RoomId, itemId: string, userId: string): PendingUpload {
    const upload = this.findUpload(room, itemId);
    const item = this.item(room, itemId);
    if (!item && !upload) throw new JamError('item_not_found');
    // Whoever sends it (a fetcher that lost the race included): the audio is here already.
    if (item?.status === 'ready') throw new JamError('already_uploaded');
    const requester = item?.requestedBy ?? upload?.requestedBy;
    if (userId !== requester && userId !== upload?.fetcher?.userId) {
      throw new JamError('not_requester');
    }
    if (!upload || upload.receiving) throw new JamError('already_uploaded');
    upload.receiving = true;
    return copyUpload(upload);
  }

  /**
   * Asks `fetcher`'s app for the audio of `videoId` (in the requester's stead), counting the
   * attempt. False when nobody awaits that song anymore.
   */
  assignFetcher(videoId: string, fetcher: { id: string; userId: string }): boolean {
    const upload = this.uploads.get(videoId);
    if (!upload) return false;
    upload.fetcher = { userId: fetcher.userId, connectionId: fetcher.id, assignedAt: this.now() };
    upload.assignments += 1;
    if (!upload.tried.includes(fetcher.userId)) upload.tried.push(fetcher.userId);
    return true;
  }

  /**
   * The upload claimed by `beginUpload` was given up before anything of it was kept: the songs
   * keep waiting and someone else may send it. The upload as it is now, or undefined when nobody
   * awaits it anymore.
   */
  releaseUpload(upload: Pick<PendingUpload, 'videoId' | 'itemId'>): PendingUpload | undefined {
    const current = this.uploads.get(upload.videoId);
    if (!current || current.itemId !== upload.itemId) return undefined;
    current.receiving = false;
    return copyUpload(current);
  }

  /** True while `upload` is still the one songs wait for (not timed out, not abandoned). */
  isAwaited(upload: Pick<PendingUpload, 'videoId' | 'itemId'>): boolean {
    return this.uploads.get(upload.videoId)?.itemId === upload.itemId;
  }

  /**
   * The audio arrived: every song waiting for that videoId becomes ready (with the file's exact
   * duration when known) and idle rooms start playing. False when nobody awaits it anymore.
   */
  completeUpload(upload: Pick<PendingUpload, 'videoId' | 'itemId'>, durationMs?: number): boolean {
    if (!this.isAwaited(upload)) return false;
    this.uploads.delete(upload.videoId);
    for (const [room, state] of this.rooms) {
      let changed = false;
      for (const item of state.queue) {
        if (item.track.videoId !== upload.videoId || item.status !== 'downloading') continue;
        item.status = 'ready';
        if (durationMs !== undefined && durationMs > 0) item.track.durationMs = durationMs;
        changed = true;
      }
      if (!changed) continue;
      this.touch(room);
      if (!state.current) this.startNext(room);
    }
    this.flush();
    return true;
  }

  /** The upload failed: every song waiting for it leaves the queue. */
  failUpload(upload: Pick<PendingUpload, 'videoId' | 'itemId'>): void {
    if (!this.isAwaited(upload)) return;
    this.dropUpload(upload.videoId);
    this.flush();
  }

  /**
   * A song's audio turned out unusable after all (a streamed upload that failed once its songs
   * were ready): every copy of it leaves, in every room (histories included), and the one playing
   * moves on without entering the history.
   */
  dropVideo(videoId: string): void {
    this.uploads.delete(videoId);
    for (const [room, state] of this.rooms) {
      const keep = (item: JamItem): boolean => item.track.videoId !== videoId;
      const queue = state.queue.filter(keep);
      const history = state.history.filter(keep);
      if (queue.length !== state.queue.length || history.length !== state.history.length) {
        state.queue = queue;
        state.history = history;
        this.touch(room);
      }
      if (state.current?.item.track.videoId === videoId) this.advance(room, false);
    }
    this.flush();
  }

  /** The exact duration of a song's audio (known once it is whole), for every copy of it. */
  setDuration(videoId: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    for (const [room, state] of this.rooms) {
      const items = [
        ...(state.current ? [state.current.item] : []),
        ...state.queue,
        ...state.history,
      ];
      for (const item of items) {
        if (item.track.videoId !== videoId || item.track.durationMs === durationMs) continue;
        item.track.durationMs = durationMs;
        this.touch(room);
      }
    }
    this.flush();
  }

  /**
   * Drops the songs whose audio did not arrive in time. One being received gets as long again
   * before it is given up too.
   */
  expireUploads(): void {
    const now = this.now();
    for (const upload of [...this.uploads.values()]) {
      const deadline = upload.receiving ? upload.deadline + this.uploadTimeoutMs : upload.deadline;
      if (now >= deadline) this.dropUpload(upload.videoId);
    }
    this.flush();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** The fetcher asked, if any, is not saved: its connection will not outlive the process. */
  toJSON(): PersistedJam {
    return {
      version: 1,
      rooms: [...this.rooms.values()].map((state) => structuredClone(state)),
      uploads: [...this.uploads.values()].map((upload) => ({
        ...copyUpload(upload),
        receiving: false,
        fetcher: null,
      })),
    };
  }

  /**
   * Replaces everything with a persisted state (already validated) without emitting: nobody is
   * listening yet when it is loaded. Songs waiting for an upload nobody will send are dropped.
   */
  load(data: PersistedJam): void {
    this.rooms.clear();
    this.uploads.clear();
    for (const upload of data.uploads) {
      this.uploads.set(upload.videoId, { ...copyUpload(upload), receiving: false, fetcher: null });
    }
    for (const state of data.rooms) {
      const queue = state.queue.filter(
        (item) => item.status === 'ready' || this.uploads.has(item.track.videoId),
      );
      const history = (state.history ?? [])
        .filter((item) => item.status === 'ready')
        .slice(0, JAM_HISTORY_MAX);
      const loaded: RoomJam = { room: state.room, current: state.current, queue, history };
      if (!loaded.current) {
        const index = queue.findIndex((item) => item.status === 'ready');
        if (index >= 0) {
          const [item] = queue.splice(index, 1);
          if (item) loaded.current = this.nowPlaying(item);
        }
      }
      if (!isJamEmpty(loaded)) this.rooms.set(state.room, structuredClone(loaded));
    }
    this.forgetUnwantedUploads();
    this.touched.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private findUpload(room: RoomId, itemId: string): PendingUpload | undefined {
    return [...this.uploads.values()].find(
      (candidate) => candidate.itemId === itemId && candidate.room === room,
    );
  }

  private ensure(room: RoomId): RoomJam {
    let state = this.rooms.get(room);
    if (!state) {
      state = emptyJam(room);
      this.rooms.set(room, state);
    }
    return state;
  }

  private nowPlaying(item: JamItem): JamNowPlaying {
    return { item, positionMs: 0, at: this.now(), paused: false, pausedBy: null };
  }

  /**
   * Ends the song playing and starts the next ready one, if any. `played` (it ended or was
   * skipped, as opposed to failing): the song goes to the front of the history.
   */
  private advance(room: RoomId, played = true): void {
    const state = this.rooms.get(room);
    if (!state) return;
    if (played && state.current) {
      state.history.unshift(state.current.item);
      state.history.splice(JAM_HISTORY_MAX);
      this.onHistory(state.current.item.track.videoId);
    }
    state.current = null;
    this.touch(room);
    this.startNext(room);
  }

  private startNext(room: RoomId): void {
    const state = this.rooms.get(room);
    if (!state || state.current) return;
    const index = state.queue.findIndex((item) => item.status === 'ready');
    if (index < 0) return;
    const [item] = state.queue.splice(index, 1);
    if (!item) return;
    state.current = this.nowPlaying(item);
    this.onStart(item);
    this.touch(room);
  }

  /** Forgets an upload and removes every song still waiting for it, in every room. */
  private dropUpload(videoId: string): void {
    this.uploads.delete(videoId);
    for (const [room, state] of this.rooms) {
      const queue = state.queue.filter(
        (item) => item.track.videoId !== videoId || item.status !== 'downloading',
      );
      if (queue.length === state.queue.length) continue;
      state.queue = queue;
      this.touch(room);
    }
  }

  /** Uploads no song waits for anymore are forgotten (a late PUT then gets item_not_found). */
  private forgetUnwantedUploads(): void {
    const waiting = new Set<string>();
    for (const state of this.rooms.values()) {
      for (const item of state.queue) {
        if (item.status === 'downloading') waiting.add(item.track.videoId);
      }
    }
    for (const videoId of [...this.uploads.keys()]) {
      if (!waiting.has(videoId)) this.uploads.delete(videoId);
    }
  }

  private touch(room: RoomId): void {
    this.touched.add(room);
  }

  /**
   * Emits each touched room once. A room left with nothing playing nor queued is over: forgotten
   * (its history with it) and announced as an empty jam.
   */
  private flush(): void {
    if (this.touched.size === 0) return;
    const rooms = [...this.touched];
    this.touched.clear();
    const serverTime = this.now();
    const updates: JamUpdate[] = [];
    for (const room of rooms) {
      const state = this.rooms.get(room);
      if (state && isJamEmpty(state)) this.rooms.delete(room);
      updates.push({ type: 'jam_updated', state: this.state(room), serverTime });
    }
    this.forgetUnwantedUploads();
    for (const update of updates) {
      for (const listener of this.listeners) listener(update);
    }
  }
}
