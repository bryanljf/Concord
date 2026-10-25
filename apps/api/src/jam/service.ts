import { open, type FileHandle } from 'node:fs/promises';
import { finished, Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  JAM_MAX_DURATION_MS,
  JAM_SEARCH_MAX_LENGTH,
  JAM_STREAM_START_BYTES,
  JAM_UPLOAD_MAX_BYTES,
  JAM_UPLOAD_TIMEOUT_MS,
  jamPositionAt,
  YOUTUBE_VIDEO_ID_PATTERN,
  type JamEnqueueResponse,
  type JamEvent,
  type JamItem,
  type JamNowPlaying,
  type JamRecentResponse,
  type JamSearchResponse,
  type JamSnapshot,
  type JamTrack,
  type RoomId,
} from '@concord/shared';
import type { ApiConfig } from '../config';
import { createJamBotToken } from '../livekit';
import type { Logger } from '../logger';
import type { PresenceStore } from '../presence-store';
import { retryDelayMs } from '../resync';
import {
  createJamBotClient,
  JamBotError,
  type BotEvent,
  type BotEventStream,
  type BotRoomState,
  type BotRoomStatus,
  type JamBot,
} from './bot-client';
import { JamAudioCache } from './cache';
import { JamError } from './errors';
import { JamStateWriter, readJamStateFile } from './state-file';
import {
  JamStore,
  withoutReadySongs,
  type JamUpdate,
  type PendingUpload,
  type PersistedJam,
} from './store';
import { createYouTubeMusic, type YouTubeMusic } from './youtube';

/** A room with nobody in it (presence) for this long has its jam cleared and the bot leaves. */
export const JAM_EMPTY_ROOM_MS = 2 * 60_000;

/** How often upload deadlines, stalled uploads, empty rooms and idle bots are checked. */
export const JAM_SWEEP_INTERVAL_MS = 5_000;

/** How often the audio cache is trimmed (also once at start and after every upload). */
export const JAM_CACHE_MAINTENANCE_MS = 10 * 60_000;

/**
 * After a room's jam ends the bot stays in it, silent, this long before leaving: a song added
 * meanwhile starts without the bot joining LiveKit again.
 */
export const JAM_BOT_LINGER_MS = 5 * 60_000;

/**
 * An upload that sends nothing for this long is given up (the bot also gives up on a file it
 * plays as it grows after 30 s without new data).
 */
export const JAM_UPLOAD_IDLE_MS = 30_000;

/** Attempts at telling the bot that a file it may play as it grows is complete or failed. */
const FILE_NOTICE_ATTEMPTS = 8;

/** Uploads are read by the bot (another uid in production) while they are written. */
const READABLE_MODE = 0o644;

/** What `GET /api/presence?jam=1` streams. */
export interface JamFeed {
  snapshot(): JamSnapshot;
  subscribe(listener: (event: JamEvent) => void): () => void;
}

/**
 * What the bot is doing in a room, as far as the api knows. `idle`: in the room, silent;
 * `unknown`: a call failed midway, so it may be playing anything.
 */
interface BotView {
  itemId: string;
  state: 'playing' | 'paused' | 'idle' | 'unknown';
}

function viewState(state: BotRoomState): BotView['state'] {
  return state === 'playing' || state === 'paused' ? state : 'idle';
}

/**
 * A seek of `itemId` the bot has not confirmed yet. Until it does, what the bot says about that
 * song's position is outdated: the next pass plays it again from the jam's position. A new object
 * per seek, so an answer can tell whether it carried the latest one.
 */
interface PendingSeek {
  itemId: string;
}

/**
 * An audio upload being received, into `temp` in the cache. Once its first
 * JAM_STREAM_START_BYTES are on disk and the bot finds a valid header there, it goes `live`: the
 * songs waiting for it are ready and play `temp` while it grows (`growing: true`). When the body
 * ends the file is renamed to the song's; when it fails, every copy of the song leaves.
 */
interface UploadJob {
  upload: PendingUpload;
  /** The song, as queued (for its info once stored). */
  track: JamTrack | undefined;
  temp: string;
  /** `probing`: its first bytes are being checked; `live`: its songs are ready. */
  phase: 'receiving' | 'probing' | 'live';
  /** The body is still arriving. */
  receiving: boolean;
  /** The early check was started (once per upload). */
  checked: boolean;
  /** Settles (never rejects) once the early check is over. */
  probing: Promise<void>;
  /** Why the upload fails, once known. */
  failure: Error | undefined;
  /** Stops receiving the body. */
  controller: AbortController;
  /** Server clock of the last bytes received. */
  lastDataAt: number;
  /** Server clock by which the whole body must have arrived. */
  deadline: number;
  /** Bot PUTs naming `temp`, in flight: the rename waits for them (the bot opens it first). */
  plays: Set<Promise<void>>;
  /** Set while `temp` is renamed: songs starting meanwhile wait, then play the final file. */
  renaming: Promise<void> | undefined;
}

/** Early connection of the bot to a room (see `connectAhead`). */
interface ConnectAttempt {
  failures: number;
  running: Promise<void> | undefined;
  timer: NodeJS.Timeout | undefined;
}

/** Errors that only mean the client went away mid-upload. */
const INTERRUPTED = new Set([
  'ERR_STREAM_PREMATURE_CLOSE',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'ABORT_ERR',
]);

interface ReceiveOptions {
  maxBytes: number;
  signal: AbortSignal;
  /** Bytes arrived. */
  onData(): void;
  /** `total` bytes are written to the file (the bot can read them). */
  onWritten(total: number): void;
}

async function writeFully(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

/**
 * Writes a request body to `path` as it arrives (readable by the bot meanwhile), at most
 * `maxBytes`. On failure the request is only unpiped, not destroyed (as `pipeline` would), so
 * the error answer can still reach the client.
 */
async function receiveFile(body: Readable, path: string, options: ReceiveOptions): Promise<void> {
  const handle = await open(path, 'w', READABLE_MODE);
  try {
    await handle.chmod(READABLE_MODE).catch(() => undefined); // whatever the umask
    let received = 0;
    let written = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        options.onData();
        if (received > options.maxBytes) callback(new JamError('payload_too_large'));
        else callback(null, chunk);
      },
    });
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        writeFully(handle, chunk).then(() => {
          written += chunk.length;
          options.onWritten(written);
          callback();
        }, callback);
      },
    });
    const stopForwarding = finished(body, (err) => {
      if (err) counted.destroy(err);
    });
    const abort = (): void => {
      counted.destroy(options.signal.reason as Error);
    };
    options.signal.addEventListener('abort', abort, { once: true });
    body.pipe(counted);
    try {
      await pipeline(counted, sink);
    } finally {
      body.unpipe(counted);
      stopForwarding();
      options.signal.removeEventListener('abort', abort);
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export interface JamServiceOptions {
  rooms: readonly RoomId[];
  presence: Pick<PresenceStore, 'participant' | 'snapshot'>;
  youtube: YouTubeMusic;
  /** Undefined: this server has no jam bot, so the Jam is unavailable (search still works). */
  bot: JamBot | undefined;
  cache: JamAudioCache;
  /** Where the jam is persisted once started; undefined keeps it in memory only. */
  stateFile?: string;
  /** LiveKit URL the bot joins with. */
  livekitUrl: string;
  /** A fresh LiveKit token for the bot in `room` (minted for every `PUT` and `connect`). */
  botToken: (room: RoomId) => Promise<string>;
  log: Logger;
  now?: () => number;
  newId?: () => string;
  uploadMaxBytes?: number;
  uploadTimeoutMs?: number;
  /** An upload silent this long is given up (default JAM_UPLOAD_IDLE_MS). */
  uploadIdleMs?: number;
  /** Bytes of an upload on disk before its song may play (default JAM_STREAM_START_BYTES). */
  streamStartBytes?: number;
  emptyRoomMs?: number;
  /** How long the bot stays in a room after its jam ends (default JAM_BOT_LINGER_MS). */
  botLingerMs?: number;
  sweepIntervalMs?: number;
  cacheMaintenanceMs?: number;
  persistDebounceMs?: number;
  /** Delay before retrying a failed bot update, after the n-th consecutive failure. */
  retryDelay?: (failures: number) => number;
}

/**
 * The Jam: the queues (JamStore), YouTube Music, the audio cache, the persisted state and the
 * bot, kept in step. The api owns every decision; the bot is told what to play and reports when
 * a song ends. When the bot is unreachable the jam is kept as is and the bot is caught up once it
 * is back (`GET /v1/rooms` on every reconnection of its event stream, plus retries).
 */
export class JamService implements JamFeed {
  readonly uploadMaxBytes: number;
  private readonly store: JamStore;
  private readonly rooms: ReadonlySet<RoomId>;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly emptyRoomMs: number;
  private readonly botLingerMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly uploadIdleMs: number;
  private readonly streamStartBytes: number;
  private readonly retryDelay: (failures: number) => number;
  private readonly botView = new Map<RoomId, BotView>();
  private readonly seeks = new Map<RoomId, PendingSeek>();
  private readonly syncing = new Map<RoomId, Promise<void>>();
  private readonly dirty = new Set<RoomId>();
  private readonly syncFailures = new Map<RoomId, number>();
  private readonly retryTimers = new Map<RoomId, NodeJS.Timeout>();
  private readonly emptySince = new Map<RoomId, number>();
  /** Rooms whose jam is over while the bot is still there: since when (server clock). */
  private readonly idleSince = new Map<RoomId, number>();
  /** Rooms the bot leaves without lingering (nobody is there). */
  private readonly leaveNow = new Set<RoomId>();
  private readonly connects = new Map<RoomId, ConnectAttempt>();
  /** Uploads being received. */
  private readonly jobs = new Set<UploadJob>();
  /** Live uploads (their songs play the growing file), by videoId. */
  private readonly streams = new Map<string, UploadJob>();
  /** Songs that started playing while their upload streamed: when, for their info once stored. */
  private readonly startedStreaming = new Map<string, number>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private maintaining: Promise<void> = Promise.resolve();
  private writer: JamStateWriter | undefined;
  private events: BotEventStream | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private cacheTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: JamServiceOptions) {
    this.rooms = new Set(options.rooms);
    this.now = options.now ?? Date.now;
    this.log = options.log;
    this.uploadMaxBytes = options.uploadMaxBytes ?? JAM_UPLOAD_MAX_BYTES;
    this.emptyRoomMs = options.emptyRoomMs ?? JAM_EMPTY_ROOM_MS;
    this.botLingerMs = options.botLingerMs ?? JAM_BOT_LINGER_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? JAM_UPLOAD_TIMEOUT_MS;
    this.uploadIdleMs = options.uploadIdleMs ?? JAM_UPLOAD_IDLE_MS;
    this.streamStartBytes = options.streamStartBytes ?? JAM_STREAM_START_BYTES;
    this.retryDelay = options.retryDelay ?? retryDelayMs;
    this.store = new JamStore({
      now: this.now,
      newId: options.newId,
      uploadTimeoutMs: this.uploadTimeoutMs,
      // A song that just played may play again ("Música anterior"): its audio was just used.
      onHistory: (videoId) => void options.cache.touch(videoId),
      onStart: (item) => this.noteStarted(item),
    });
    this.store.subscribe((update) => this.onUpdate(update));
  }

  get available(): boolean {
    return this.options.bot !== undefined;
  }

  snapshot(): JamSnapshot {
    return this.store.snapshot(this.available);
  }

  subscribe(listener: (event: JamEvent) => void): () => void {
    return this.store.subscribe(listener);
  }

  /**
   * Warms YouTube Music up, then loads the persisted jam, prepares the cache and starts following
   * the bot. Without a bot it only warms up (and leaves the state file alone).
   */
  async start(): Promise<void> {
    // Search works with or without a bot: get YouTube Music ready for the first one.
    void this.options.youtube.warmUp?.();
    const bot = this.options.bot;
    if (!bot) return;
    try {
      await this.options.cache.prepare();
    } catch (err) {
      this.log.error({ err, dir: this.options.cache.dir }, 'could not prepare the jam cache');
    }
    const { stateFile } = this.options;
    if (stateFile) {
      try {
        const data = await readJamStateFile(stateFile, this.options.rooms, this.log, this.now);
        if (data) this.store.load(await this.withAudioOnDisk(data));
      } catch (err) {
        this.log.error({ err, path: stateFile }, 'could not read the jam state; starting empty');
      }
      this.writer = new JamStateWriter({
        path: stateFile,
        read: () => this.store.toJSON(),
        log: this.log,
        debounceMs: this.options.persistDebounceMs,
      });
    }
    // Presence is empty until the first LiveKit resync: give restored rooms the full grace.
    for (const room of this.store.activeRooms()) this.emptySince.set(room, this.now());
    this.sweepTimer = setInterval(
      () => this.sweep(),
      this.options.sweepIntervalMs ?? JAM_SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref();
    this.events = bot.events({
      onConnect: () => this.reconcile(),
      onEvent: (event) => this.onBotEvent(event),
    });
    void this.maintainCache();
    this.cacheTimer = setInterval(
      () => void this.maintainCache(),
      this.options.cacheMaintenanceMs ?? JAM_CACHE_MAINTENANCE_MS,
    );
    this.cacheTimer.unref();
  }

  /** Stops following the bot and saves the jam (the bot keeps playing: a deploy keeps the jam). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.events?.stop();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.cacheTimer) clearInterval(this.cacheTimer);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const attempt of this.connects.values()) clearTimeout(attempt.timer);
    this.connects.clear();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([this.writer?.flush(), this.options.cache.idle()]);
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  /**
   * YouTube Music songs for `query` (works without a bot: the server only searches), with the
   * ones whose audio the server already has.
   */
  async search(query: string): Promise<JamSearchResponse> {
    const trimmed = query.trim();
    if (trimmed === '' || [...trimmed].length > JAM_SEARCH_MAX_LENGTH) {
      throw new JamError('invalid_query');
    }
    let results: JamTrack[];
    try {
      results = await this.options.youtube.search(trimmed);
    } catch (err) {
      this.log.warn({ err }, 'YouTube Music search failed');
      throw new JamError('search_failed');
    }
    return { results, cached: await this.cachedAmong(results) };
  }

  /**
   * "Recentes": the songs that started playing (in any room) and whose audio the server still
   * has, the last to start first; adding one needs no download. Empty without a bot.
   */
  async recent(): Promise<JamRecentResponse> {
    if (!this.available) return { tracks: [] };
    return { tracks: await this.options.cache.recent() };
  }

  /**
   * Adds a song. Answers right away: the bot is told in the background (joining LiveKit takes a
   * while) and the jam events say when the song plays. A song still to be downloaded brings the
   * bot into an idle room meanwhile, so its LiveKit join overlaps the download.
   */
  async enqueue(userId: string, room: RoomId, videoId: string): Promise<JamEnqueueResponse> {
    this.assertCanChange(room, userId);
    if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) throw new JamError('invalid_video');
    this.store.assertQueueNotFull(room);
    let track: JamTrack | null;
    try {
      track = await this.options.youtube.track(videoId);
    } catch (err) {
      this.log.warn({ err, videoId }, 'YouTube Music lookup failed');
      throw new JamError('search_failed');
    }
    if (!track) throw new JamError('track_not_found');
    if (track.durationMs > JAM_MAX_DURATION_MS) throw new JamError('too_long');
    // A song whose upload is streaming is as good as cached: its copies play the same file.
    const streaming = this.streams.has(videoId);
    const cached =
      (await this.options.cache.has(videoId)) || streaming || this.streams.has(videoId);
    const result = this.store.enqueue(room, track, userId, cached);
    if (result.item.status === 'downloading') this.connectAhead(room);
    return result;
  }

  /**
   * Receives the audio of `itemId` from its requester (who need not be in the room anymore),
   * written to a temporary file in the cache as it arrives. Once JAM_STREAM_START_BYTES are there
   * and the bot finds a valid header, the songs waiting for it are ready and may play the file
   * while it grows; when the body ends the bot checks all of it and the file becomes the song's
   * audio. A shorter upload is checked once whole. Any failure after the upload was claimed makes
   * every song waiting for it leave (even ones already playing it).
   */
  async upload(
    userId: string,
    room: RoomId,
    itemId: string,
    body: Readable,
    declaredBytes?: number,
  ): Promise<void> {
    this.assertAvailable();
    this.assertRoom(room);
    const upload = this.store.beginUpload(room, itemId, userId);
    const job: UploadJob = {
      upload,
      track: this.store.track(upload.videoId),
      temp: this.options.cache.tempFile(),
      phase: 'receiving',
      receiving: true,
      checked: false,
      probing: Promise.resolve(),
      failure: undefined,
      controller: new AbortController(),
      lastDataAt: this.now(),
      deadline: upload.deadline + this.uploadTimeoutMs,
      plays: new Set(),
      renaming: undefined,
    };
    this.jobs.add(job);
    try {
      try {
        await this.receive(job, body, declaredBytes);
      } catch (err) {
        job.failure ??= err as Error;
      }
      job.receiving = false;
      await job.probing;
      if (job.phase === 'live') await this.finishLive(job);
      else await this.finishWhole(job);
    } finally {
      this.jobs.delete(job);
    }
  }

  /** Removes an upcoming song, or skips it when it is the one playing. */
  async remove(userId: string, room: RoomId, itemId: string): Promise<void> {
    this.assertCanChange(room, userId);
    this.store.remove(room, itemId);
    await this.whenSynced(room);
  }

  async skip(userId: string, room: RoomId, itemId: string): Promise<void> {
    this.assertCanChange(room, userId);
    this.store.skip(room, itemId);
    await this.whenSynced(room);
  }

  async pause(userId: string, room: RoomId): Promise<void> {
    this.assertCanChange(room, userId);
    this.store.pause(room, userId);
    await this.whenSynced(room);
  }

  async resume(userId: string, room: RoomId): Promise<void> {
    this.assertCanChange(room, userId);
    this.store.resume(room);
    await this.whenSynced(room);
  }

  /**
   * Moves the song playing to `positionMs` (clamped to the song) for everyone, only if it still is
   * `itemId` (`stale` otherwise); a paused song stays paused there. The jam moves at once, then the
   * bot plays the same file again from there (the upload's, as it grows, while it streams: past
   * what arrived so far it waits for the rest) and where it really landed is adopted. A position
   * within JAM_SEEK_TOLERANCE_MS of the current one changes nothing.
   */
  async seek(userId: string, room: RoomId, itemId: string, positionMs: number): Promise<void> {
    this.assertCanChange(room, userId);
    // The update this emits asks for a bot pass, which runs on a later tick: marked by then.
    if (this.store.seek(room, itemId, positionMs)) this.seeks.set(room, { itemId });
    await this.whenSynced(room);
  }

  /**
   * "Música anterior": plays the latest song of the history from the start, for everyone; the
   * song playing (still `itemId`, null when nothing plays; `stale` otherwise) goes back to the
   * front of the queue. `no_previous` with an empty history; `previous_unavailable` when that
   * song's audio left the cache (it leaves the history too).
   */
  async previous(userId: string, room: RoomId, itemId: string | null): Promise<void> {
    this.assertCanChange(room, userId);
    const previous = this.store.previousOf(room, itemId);
    const { videoId } = previous.track;
    // Its upload may still stream in (it played as it arrived): as good as cached.
    if (!this.streams.has(videoId) && !(await this.options.cache.exists(videoId))) {
      this.log.warn({ room, videoId }, 'the previous jam song left the cache, forgetting it');
      this.store.forgetPrevious(room, previous.id);
      throw new JamError('previous_unavailable');
    }
    // Checked again: the jam may have moved on while the cache was looked at.
    this.store.playPrevious(room, itemId, previous.id);
    await this.whenSynced(room);
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  /**
   * Drops songs whose audio never came, gives up stalled uploads, clears rooms nobody has been in
   * for a while and lets the bot leave rooms whose jam ended a while ago.
   */
  sweep(): void {
    if (!this.available || this.stopped) return;
    this.store.expireUploads();
    const now = this.now();
    for (const job of this.jobs) {
      if (!job.receiving) continue;
      if (now - job.lastDataAt >= this.uploadIdleMs) {
        this.stopUpload(job, new JamError('invalid_audio', 'O envio do áudio parou.'));
      } else if (now >= job.deadline) {
        this.stopUpload(job, new JamError('invalid_audio', 'O envio do áudio demorou demais.'));
      }
    }
    const people = this.options.presence.snapshot().rooms;
    for (const room of this.store.activeRooms()) {
      if ((people[room]?.length ?? 0) > 0) {
        this.emptySince.delete(room);
        continue;
      }
      const since = this.emptySince.get(room);
      if (since === undefined) {
        this.emptySince.set(room, now);
      } else if (now - since >= this.emptyRoomMs) {
        this.log.info({ room }, 'nobody left in the room, clearing its jam');
        this.emptySince.delete(room);
        this.leaveNow.add(room);
        this.store.clear(room);
      }
    }
    for (const room of [...this.emptySince.keys()]) {
      if (this.store.isEmpty(room)) this.emptySince.delete(room);
    }
    for (const [room, since] of this.idleSince) {
      if (now - since >= this.botLingerMs) void this.requestSync(room);
    }
  }

  /** Resolves once no bot update, early connection nor song info write is in flight (tests). */
  async settled(): Promise<void> {
    for (;;) {
      const pending = [...this.syncing.values()];
      for (const attempt of this.connects.values()) {
        if (attempt.running) pending.push(attempt.running);
      }
      if (pending.length === 0) break;
      await Promise.all(pending);
    }
    await this.options.cache.idle();
  }

  /**
   * Trims the cache in the background, one pass at a time (never a song some room still has nor
   * an upload in progress). Resolves once this pass is done.
   */
  maintainCache(): Promise<void> {
    this.maintaining = this.maintaining.then(async () => {
      try {
        const keep = this.store.referencedVideoIds();
        const temps = new Set<string>();
        for (const job of this.jobs) {
          keep.add(job.upload.videoId);
          temps.add(job.temp);
        }
        const result = await this.options.cache.maintain(keep, temps);
        const { expired, evicted, temps: deleted, orphans } = result;
        if (expired.length + evicted.length + deleted + orphans > 0) {
          this.log.info(
            { expired: expired.length, evicted: evicted.length, temps: deleted, orphans },
            'jam cache trimmed',
          );
        }
      } catch (err) {
        this.log.warn({ err }, 'could not trim the jam cache');
      }
    });
    return this.maintaining;
  }

  // -------------------------------------------------------------------------
  // Internals: requests
  // -------------------------------------------------------------------------

  private assertAvailable(): JamBot {
    if (!this.options.bot) throw new JamError('jam_unavailable');
    return this.options.bot;
  }

  private assertRoom(room: RoomId): void {
    if (!this.rooms.has(room)) throw new JamError('unknown_room', `A sala "${room}" não existe.`);
  }

  /** Mutations need the Jam, a configured room and the caller in that room. */
  private assertCanChange(room: RoomId, userId: string): void {
    this.assertAvailable();
    this.assertRoom(room);
    if (!this.options.presence.participant(room, userId)) throw new JamError('not_in_room');
  }

  /** The videoIds among `tracks` whose audio is here (or streaming in, as good). */
  private async cachedAmong(tracks: readonly JamTrack[]): Promise<string[]> {
    const ids = [...new Set(tracks.map((entry) => entry.videoId))].filter((id) =>
      YOUTUBE_VIDEO_ID_PATTERN.test(id),
    );
    const here = await Promise.all(
      ids.map(async (id) => this.streams.has(id) || (await this.options.cache.exists(id))),
    );
    return ids.filter((_id, index) => here[index]);
  }

  /**
   * Drops the restored ready songs (history included) whose audio is not on disk (their upload
   * was streaming).
   */
  private async withAudioOnDisk(data: PersistedJam): Promise<PersistedJam> {
    const ready = new Set<string>();
    for (const state of data.rooms) {
      if (state.current) ready.add(state.current.item.track.videoId);
      for (const item of [...state.queue, ...(state.history ?? [])]) {
        if (item.status === 'ready') ready.add(item.track.videoId);
      }
    }
    const missing = new Set<string>();
    for (const videoId of ready) {
      if (!(await this.options.cache.exists(videoId))) missing.add(videoId);
    }
    if (missing.size === 0) return data;
    this.log.warn(
      { videoIds: [...missing] },
      'dropping restored jam songs whose audio is not in the cache',
    );
    return withoutReadySongs(data, missing);
  }

  // -------------------------------------------------------------------------
  // Internals: uploads
  // -------------------------------------------------------------------------

  /** Receives the body into `job.temp`, starting the early check once enough is on disk. */
  private async receive(job: UploadJob, body: Readable, declaredBytes?: number): Promise<void> {
    if (declaredBytes !== undefined && declaredBytes > this.uploadMaxBytes) {
      throw new JamError('payload_too_large');
    }
    await this.options.cache.ensureDir();
    try {
      await receiveFile(body, job.temp, {
        maxBytes: this.uploadMaxBytes,
        signal: job.controller.signal,
        onData: () => {
          job.lastDataAt = this.now();
        },
        onWritten: (total) => {
          if (job.checked || total < this.streamStartBytes) return;
          job.checked = true;
          job.probing = this.goLive(job).catch((err: unknown) => {
            this.log.error({ err, videoId: job.upload.videoId }, 'jam upload check failed');
          });
        },
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (err instanceof JamError || !code || !INTERRUPTED.has(code)) throw err;
      throw new JamError('invalid_audio', 'O envio do áudio foi interrompido.');
    }
  }

  /** Makes the upload fail with `err`, closing its body when it is still arriving. */
  private stopUpload(job: UploadJob, err: Error): void {
    job.failure ??= err;
    if (job.receiving && !job.controller.signal.aborted) job.controller.abort(err);
  }

  /**
   * The first bytes of an upload are on disk: once the bot finds a valid header there, every
   * song waiting for it is ready and idle rooms start playing the file as it grows. A header the
   * bot rejects fails the upload right away; when the bot cannot be reached the upload is checked
   * once whole instead.
   */
  private async goLive(job: UploadJob): Promise<void> {
    const bot = this.options.bot;
    if (!bot) return;
    const { videoId } = job.upload;
    job.phase = 'probing';
    try {
      await bot.probe(job.temp, { partial: true });
    } catch (err) {
      job.phase = 'receiving';
      if (err instanceof JamBotError && !err.retryable) {
        this.log.warn({ err, videoId }, 'a jam upload is not valid audio');
        this.stopUpload(job, new JamError('invalid_audio'));
      } else {
        this.log.warn({ err, videoId }, 'could not check a jam upload as it arrived');
      }
      return;
    }
    if (job.failure) {
      job.phase = 'receiving';
      return;
    }
    if (!this.store.isAwaited(job.upload)) {
      job.phase = 'receiving';
      this.stopUpload(job, new JamError('item_not_found'));
      return;
    }
    job.phase = 'live';
    this.streams.set(videoId, job);
    this.log.debug({ videoId }, 'jam upload playable while it streams');
    this.store.completeUpload(job.upload);
  }

  /** The bot reads the whole file: its exact duration, within the limits. */
  private async probeWhole(job: UploadJob): Promise<number> {
    const bot = this.assertAvailable();
    let durationMs: number;
    try {
      durationMs = (await bot.probe(job.temp)).durationMs;
    } catch (err) {
      const rejected = err instanceof JamBotError && !err.retryable;
      this.log.warn({ err, videoId: job.upload.videoId }, 'could not probe a jam upload');
      throw new JamError(rejected ? 'invalid_audio' : 'jam_unavailable');
    }
    if (!(durationMs > 0)) throw new JamError('invalid_audio');
    if (durationMs > JAM_MAX_DURATION_MS) {
      throw new JamError('invalid_audio', 'O áudio recebido é mais longo que o permitido.');
    }
    return Math.round(durationMs);
  }

  /** An upload that never went live ended: checked whole, it becomes the song's audio. */
  private async finishWhole(job: UploadJob): Promise<void> {
    const { cache } = this.options;
    const { upload, temp } = job;
    let durationMs: number;
    try {
      if (job.failure) throw job.failure;
      durationMs = await this.probeWhole(job);
      if (!this.store.isAwaited(upload)) throw new JamError('item_not_found');
      await cache.commit(temp, upload.videoId);
    } catch (err) {
      await cache.discard(temp);
      this.store.failUpload(upload);
      throw err;
    }
    // Ready (idle rooms start playing it); the answer does not wait for the bot.
    this.store.completeUpload(upload, durationMs);
    await this.noteStored(job, durationMs);
    void this.maintainCache();
  }

  /**
   * A live upload ended. Whole and valid: the file becomes the song's audio (renamed once no
   * PUT naming it is in flight), its copies get the exact duration and the bot is told it is
   * complete. Otherwise every copy of the song leaves.
   */
  private async finishLive(job: UploadJob): Promise<void> {
    const { videoId } = job.upload;
    let durationMs: number;
    try {
      if (job.failure) throw job.failure;
      durationMs = await this.probeWhole(job);
    } catch (err) {
      await this.failLive(job);
      throw err;
    }
    while (job.plays.size > 0) await Promise.allSettled([...job.plays]);
    let renamed = (): void => undefined;
    job.renaming = new Promise<void>((resolve) => {
      renamed = resolve;
    });
    try {
      await this.options.cache.commit(job.temp, videoId);
    } catch (err) {
      this.log.error({ err, videoId }, 'could not store a jam upload');
      await this.failLive(job);
      throw err;
    } finally {
      if (this.streams.get(videoId) === job) this.streams.delete(videoId);
      renamed();
    }
    this.store.setDuration(videoId, durationMs);
    await this.noteStored(job, durationMs);
    await this.tellBotFile('complete', job.temp);
    void this.maintainCache();
  }

  /**
   * A song started playing: its info ("Recentes") says so. Its audio may still be streaming in:
   * then the info is written once it is stored.
   */
  private noteStarted(item: JamItem): void {
    const now = this.now();
    if (this.streams.has(item.track.videoId)) this.startedStreaming.set(item.track.videoId, now);
    void this.options.cache.noteUse(item.track, { playedAt: now });
  }

  /**
   * An upload became the song's audio: its info gets the file's exact duration, and is created if
   * the song started playing while it streamed (one never played has none: not "recent").
   */
  private async noteStored(job: UploadJob, durationMs: number): Promise<void> {
    const { videoId } = job.upload;
    const playedAt = this.startedStreaming.get(videoId);
    this.startedStreaming.delete(videoId);
    const track = this.store.track(videoId) ?? job.track;
    if (!track) return;
    await this.options.cache.noteUse({ ...track, durationMs }, { playedAt, exact: true });
  }

  /**
   * A live upload failed: every copy of its song leaves (the one playing moves on; the bot also
   * reports `error` for it, which changes nothing then), the bot stops reading the file and it
   * is deleted.
   */
  private async failLive(job: UploadJob): Promise<void> {
    const { videoId } = job.upload;
    if (this.streams.get(videoId) === job) this.streams.delete(videoId);
    this.startedStreaming.delete(videoId);
    this.log.warn(
      { videoId, reason: job.failure?.message },
      'a jam upload failed after its song was ready, dropping it',
    );
    this.store.dropVideo(videoId);
    await Promise.all([this.tellBotFile('failed', job.temp), this.options.cache.discard(job.temp)]);
  }

  /**
   * Tells the bot that a file it may play as it grows is whole (`complete`) or never will be
   * (`failed`). Retried in the background while the bot cannot be reached.
   */
  private async tellBotFile(
    outcome: 'complete' | 'failed',
    file: string,
    attempt = 1,
  ): Promise<void> {
    const bot = this.options.bot;
    if (!bot || this.stopped) return;
    try {
      if (outcome === 'complete') await bot.completeFile(file);
      else await bot.failFile(file);
      if (attempt > 1) this.log.info({ file, outcome, attempt }, 'told the jam bot about a file');
    } catch (err) {
      if (attempt === 1) {
        this.log.warn({ err, file, outcome }, 'could not tell the jam bot about a file');
      }
      const retryable = err instanceof JamBotError && err.retryable;
      if (!retryable || attempt >= FILE_NOTICE_ATTEMPTS || this.stopped) return;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.tellBotFile(outcome, file, attempt + 1);
      }, this.retryDelay(attempt));
      timer.unref();
      this.timers.add(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Internals: the bot
  // -------------------------------------------------------------------------

  private onUpdate(update: JamUpdate): void {
    if (this.stopped) return;
    this.writer?.schedule();
    void this.requestSync(update.state.room);
  }

  private whenSynced(room: RoomId): Promise<void> {
    return this.syncing.get(room) ?? Promise.resolve();
  }

  /**
   * Brings the bot in line with `room`'s jam. Updates of one room run one at a time; a request
   * made meanwhile runs another pass right after (with whatever the jam is by then).
   */
  private requestSync(room: RoomId): Promise<void> {
    if (!this.options.bot || this.stopped) return Promise.resolve();
    this.dirty.add(room);
    const running = this.syncing.get(room);
    if (running) return running;
    const started = Promise.resolve().then(() => this.runSync(room));
    this.syncing.set(room, started);
    return started;
  }

  private async runSync(room: RoomId): Promise<void> {
    try {
      while (this.dirty.delete(room)) {
        if (this.stopped) return;
        try {
          if (await this.syncOnce(room)) this.syncSucceeded(room);
        } catch (err) {
          // Whatever the bot does now is unknown: the next pass plays or leaves for sure.
          this.botView.set(room, {
            itemId: this.botView.get(room)?.itemId ?? '',
            state: 'unknown',
          });
          this.scheduleRetry(room, err);
          return;
        }
      }
    } finally {
      this.syncing.delete(room);
    }
  }

  /** One pass; true when the bot was called (and answered). */
  private async syncOnce(room: RoomId): Promise<boolean> {
    const bot = this.options.bot;
    if (!bot) return false;
    const current = this.store.current(room);
    const view = this.botView.get(room);
    // A seek of a song no longer playing has nothing left to do.
    if (this.seeks.has(room) && this.seeks.get(room)?.itemId !== current?.item.id) {
      this.seeks.delete(room);
    }
    if (!this.store.isIdle(room)) {
      this.idleSince.delete(room);
      this.leaveNow.delete(room);
    }
    if (!current) return this.syncSilent(room, view);
    const itemId = current.item.id;
    if (
      this.seeks.has(room) ||
      view?.itemId !== itemId ||
      view.state === 'idle' ||
      view.state === 'unknown'
    ) {
      return this.play(room, current);
    }
    if (current.paused === (view.state === 'paused')) return false;
    let status: BotRoomStatus;
    try {
      status = current.paused ? await bot.pause(room) : await bot.resume(room);
    } catch (err) {
      if (!(err instanceof JamBotError) || err.status !== 404) throw err;
      // The bot is not playing it after all (it restarted?): play it again from where it is.
      this.botView.delete(room);
      this.dirty.add(room);
      return true;
    }
    this.botView.set(room, { itemId: status.itemId, state: viewState(status.state) });
    this.adoptPosition(room, itemId, status.positionMs, status.state === 'paused');
    return true;
  }

  /**
   * Where the bot says `itemId` is, adopted unless a seek of it has yet to reach the bot (the
   * position the bot reports is about to change).
   */
  private adoptPosition(room: RoomId, itemId: string, positionMs: number, paused: boolean): void {
    if (this.seeks.get(room)?.itemId === itemId) return;
    this.store.setPosition(room, itemId, positionMs, paused);
  }

  /**
   * Nothing to play in `room`. While songs still wait for their audio the bot stays, silent,
   * ready for the next one. Once the jam is over it stays JAM_BOT_LINGER_MS more (a song added
   * meanwhile starts without joining LiveKit again), then leaves; right away when nobody is there.
   */
  private async syncSilent(room: RoomId, view: BotView | undefined): Promise<boolean> {
    const bot = this.options.bot;
    if (!bot || !view) {
      this.idleSince.delete(room);
      this.leaveNow.delete(room);
      return false;
    }
    if (this.store.isIdle(room)) {
      const now = this.now();
      const since = this.idleSince.get(room) ?? now;
      this.idleSince.set(room, since);
      if (this.leaveNow.has(room) || now - since >= this.botLingerMs) {
        await bot.leave(room);
        this.botView.delete(room);
        this.idleSince.delete(room);
        this.leaveNow.delete(room);
        this.store.clear(room);
        return true;
      }
    }
    if (view.state === 'idle' || view.state === 'paused') return false;
    // Still playing a song nobody wants anymore: silence it without leaving the room.
    let status: BotRoomStatus;
    try {
      status = await bot.pause(room);
    } catch (err) {
      if (!(err instanceof JamBotError) || err.status !== 404) throw err;
      this.botView.set(room, { itemId: view.itemId, state: 'idle' });
      return true;
    }
    this.botView.set(room, { itemId: status.itemId, state: viewState(status.state) });
    return true;
  }

  /**
   * Has the bot play `current` from where it is: the song's file, or the temporary file of its
   * upload while that still streams (`growing`). Its answer confirms the seek it carries, if any;
   * after a newer seek it is outdated (the next pass sends that one).
   */
  private async play(room: RoomId, current: JamNowPlaying): Promise<boolean> {
    const bot = this.assertAvailable();
    const itemId = current.item.id;
    const { videoId } = current.item.track;
    const seek = this.seeks.get(room); // already in `current`
    await this.options.cache.touch(videoId); // starts playing: just used
    const token = await this.options.botToken(room);
    let job = this.streams.get(videoId);
    while (job?.renaming) {
      await job.renaming;
      job = this.streams.get(videoId);
    }
    const file = job ? job.temp : this.options.cache.fileFor(videoId);
    const request = bot.play(room, {
      livekitUrl: this.options.livekitUrl,
      token,
      itemId,
      file,
      offsetMs: Math.round(jamPositionAt(current, this.now())),
      paused: current.paused,
      growing: job !== undefined,
    });
    if (job) {
      const plays = job.plays;
      const settled = request.then(
        () => undefined,
        () => undefined,
      );
      plays.add(settled);
      void settled.then(() => plays.delete(settled));
    }
    let status: BotRoomStatus;
    try {
      status = await request;
    } catch (err) {
      if (!(err instanceof JamBotError) || err.retryable) throw err;
      // The bot cannot play this file (missing, or not valid audio): drop the song.
      this.log.warn({ err, room, itemId, videoId }, 'the jam bot rejected a song, skipping it');
      // A broken file is forgotten; a growing one is up to its upload.
      if (err.code === 'invalid_audio' && !job) await this.options.cache.discardSong(videoId);
      this.store.finish(room, itemId, 'failed');
      return true;
    }
    this.botView.set(room, { itemId, state: viewState(status.state) });
    if (this.seeks.get(room) !== seek) return true;
    this.seeks.delete(room);
    if (status.state === 'ended')
      this.store.finish(room, itemId); // nothing after the offset
    else if (status.state === 'error') this.store.finish(room, itemId, 'failed');
    else this.store.setPosition(room, itemId, status.positionMs, status.state === 'paused');
    return true;
  }

  private syncSucceeded(room: RoomId): void {
    const failures = this.syncFailures.get(room);
    if (failures) this.log.info({ room, failures }, 'jam bot caught up');
    this.syncFailures.delete(room);
    const timer = this.retryTimers.get(room);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(room);
  }

  /** The bot is down or failing: keep the jam as is and try again later (logged once per streak). */
  private scheduleRetry(room: RoomId, err: unknown): void {
    if (this.stopped) return;
    const failures = (this.syncFailures.get(room) ?? 0) + 1;
    this.syncFailures.set(room, failures);
    if (failures === 1) this.log.warn({ err, room }, 'could not update the jam bot, retrying');
    const previous = this.retryTimers.get(room);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.retryTimers.delete(room);
      void this.requestSync(room);
    }, this.retryDelay(failures));
    timer.unref();
    this.retryTimers.set(room, timer);
  }

  /** The bot should join `room` ahead of its first song: songs wait there, none plays, no bot. */
  private wantsBotAhead(room: RoomId): boolean {
    return (
      !this.stopped &&
      !this.store.isIdle(room) &&
      this.store.current(room) === null &&
      !this.botView.has(room)
    );
  }

  /**
   * Brings the bot into `room` (`POST /v1/rooms/{room}/connect`) while its first song is still
   * downloading, so the LiveKit join overlaps the download. In the background, retried with
   * backoff while it is still useful.
   */
  private connectAhead(room: RoomId): void {
    if (this.connects.has(room) || !this.wantsBotAhead(room)) return;
    const attempt: ConnectAttempt = { failures: 0, running: undefined, timer: undefined };
    this.connects.set(room, attempt);
    this.runConnect(room, attempt);
  }

  private runConnect(room: RoomId, attempt: ConnectAttempt): void {
    attempt.timer = undefined;
    const bot = this.options.bot;
    if (!bot || this.connects.get(room) !== attempt || !this.wantsBotAhead(room)) {
      if (this.connects.get(room) === attempt) this.connects.delete(room);
      return;
    }
    attempt.running = (async () => {
      try {
        const token = await this.options.botToken(room);
        const status = await bot.connect(room, { livekitUrl: this.options.livekitUrl, token });
        if (this.connects.get(room) === attempt) this.connects.delete(room);
        if (attempt.failures > 0) {
          this.log.info({ room, failures: attempt.failures }, 'jam bot joined the room');
        }
        if (!this.botView.has(room)) {
          this.botView.set(room, { itemId: status.itemId, state: viewState(status.state) });
          // The jam may have changed meanwhile (ended, or started playing): sort it out.
          void this.requestSync(room);
        }
      } catch (err) {
        attempt.failures += 1;
        if (attempt.failures === 1) {
          this.log.warn({ err, room }, 'could not bring the jam bot into the room early');
        }
        const retryable = !(err instanceof JamBotError) || err.retryable;
        if (!retryable || this.stopped || this.connects.get(room) !== attempt) {
          if (this.connects.get(room) === attempt) this.connects.delete(room);
          return;
        }
        attempt.timer = setTimeout(
          () => this.runConnect(room, attempt),
          this.retryDelay(attempt.failures),
        );
        attempt.timer.unref();
      } finally {
        attempt.running = undefined;
      }
    })();
  }

  /**
   * Catches up after (re)connecting to the bot's events, which may have been missed: songs it
   * finished meanwhile move on, its positions are adopted, and every room is synced (rooms it
   * is in that the api has no jam for are left after the usual linger).
   */
  private async reconcile(): Promise<void> {
    const bot = this.options.bot;
    if (!bot) return;
    while (this.syncing.size > 0) await Promise.all([...this.syncing.values()]);
    const statuses = await bot.rooms();
    const seen = new Set<RoomId>();
    for (const status of statuses) {
      seen.add(status.room);
      this.botView.set(status.room, { itemId: status.itemId, state: viewState(status.state) });
      if (this.store.current(status.room)?.item.id !== status.itemId) continue;
      if (status.state === 'ended' || status.state === 'error') {
        const outcome = status.state === 'ended' ? 'ended' : 'failed';
        this.store.finish(status.room, status.itemId, outcome);
      } else if (status.state === 'playing' || status.state === 'paused') {
        const paused = status.state === 'paused';
        this.adoptPosition(status.room, status.itemId, status.positionMs, paused);
      }
    }
    for (const room of [...this.botView.keys()]) {
      if (!seen.has(room)) this.botView.delete(room);
    }
    for (const room of new Set([...seen, ...this.store.activeRooms()])) {
      void this.requestSync(room);
    }
  }

  private onBotEvent(event: BotEvent): void {
    const view = this.botView.get(event.room);
    if (!view || view.itemId === event.itemId) {
      this.botView.set(event.room, { itemId: event.itemId, state: 'idle' });
    }
    if (event.type === 'error') {
      this.log.warn(
        { room: event.room, itemId: event.itemId, message: event.message },
        'the jam bot gave up on a song',
      );
    }
    // Idempotent: a song already moved on from (a failed upload, a skip) is not the current one.
    // Only one that played to its end goes to the history.
    this.store.finish(event.room, event.itemId, event.type === 'ended' ? 'ended' : 'failed');
  }
}

export interface CreateJamServiceOptions {
  config: Pick<ApiConfig, 'rooms' | 'livekit' | 'jam'>;
  presence: Pick<PresenceStore, 'participant' | 'snapshot'>;
  log: Logger;
  youtube?: YouTubeMusic;
  now?: () => number;
}

/** The Jam as configured: with a bot client when `JAM_BOT_URL` is set, unavailable otherwise. */
export function createJamService(options: CreateJamServiceOptions): JamService {
  const { config, presence, log } = options;
  const { jam } = config;
  return new JamService({
    rooms: config.rooms,
    presence,
    youtube: options.youtube ?? createYouTubeMusic(),
    bot: jam.botUrl
      ? createJamBotClient({ baseUrl: jam.botUrl, token: jam.botToken, log })
      : undefined,
    cache: new JamAudioCache(jam.cacheDir, jam.cacheMaxBytes, log, { ttlMs: jam.cacheTtlMs }),
    stateFile: jam.stateFile,
    livekitUrl: jam.livekitUrl,
    botToken: async (room) => (await createJamBotToken(config.livekit, room)).token,
    log,
    now: options.now,
  });
}
