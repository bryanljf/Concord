import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { JamEvent, JamFetchEvent, JamTrack, PresenceEvent, RoomId } from '@concord/shared';
import {
  JamBotError,
  type BotConnectRequest,
  type BotEvent,
  type BotEventHandlers,
  type BotPlayRequest,
  type BotProbeOptions,
  type BotProbeResult,
  type BotRoomStatus,
  type JamBot,
} from '../src/jam/bot-client';
import { JamAudioCache } from '../src/jam/cache';
import { JamService, type JamServiceOptions } from '../src/jam/service';
import type { YouTubeMusic } from '../src/jam/youtube';
import { PresenceStore } from '../src/presence-store';
import { fakeLogger } from './helpers';

export function track(videoId: string, overrides: Partial<JamTrack> = {}): JamTrack {
  return {
    videoId,
    title: `Song ${videoId}`,
    artists: 'Artist',
    album: null,
    durationMs: 200_000,
    artworkUrl: null,
    ...overrides,
  };
}

/** 11-character video ids for tests. */
export const VIDEO_A = 'aaaaaaaaaaa';
export const VIDEO_B = 'bbbbbbbbbbb';
export const VIDEO_C = 'ccccccccccc';

export class FakeClock {
  constructor(public time = 1_000_000) {}
  readonly now = (): number => this.time;
  advance(ms: number): void {
    this.time += ms;
  }
}

/** YouTube Music with a fixed catalog; `failing` makes every call reject. */
export class FakeYouTube implements YouTubeMusic {
  readonly tracks = new Map<string, JamTrack>();
  failing = false;
  readonly searches: string[] = [];
  readonly lookups: string[] = [];

  constructor(tracks: JamTrack[] = []) {
    for (const entry of tracks) this.tracks.set(entry.videoId, entry);
  }

  async search(query: string): Promise<JamTrack[]> {
    this.searches.push(query);
    if (this.failing) throw new Error('YouTube is down');
    return [...this.tracks.values()].filter((entry) =>
      entry.title.toLowerCase().includes(query.toLowerCase()),
    );
  }

  async track(videoId: string): Promise<JamTrack | null> {
    this.lookups.push(videoId);
    if (this.failing) throw new Error('YouTube is down');
    return this.tracks.get(videoId) ?? null;
  }
}

export type BotCall =
  | { method: 'play'; room: RoomId; request: BotPlayRequest }
  | { method: 'connect'; room: RoomId; request: BotConnectRequest }
  | { method: 'pause' | 'resume' | 'leave'; room: RoomId }
  | { method: 'probe'; file: string; partial: boolean }
  | { method: 'complete' | 'failed'; file: string }
  | { method: 'rooms' };

/** A promise tests resolve when they want (to hold a bot call in flight). */
export class Gate {
  readonly promise: Promise<void>;
  open: () => void = () => undefined;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }
}

/**
 * An in-memory jam bot that behaves like the real one (per API.md): it remembers what each room
 * plays, answers RoomStatus and lets tests push events or make it unreachable.
 */
export class FakeBot implements JamBot {
  readonly calls: BotCall[] = [];
  readonly state = new Map<RoomId, BotRoomStatus>();
  /** The file each room plays. */
  readonly files = new Map<RoomId, string>();
  /** Every call rejects as if the bot were down. */
  unreachable = false;
  /** Rejection for the next `play` (then cleared). */
  playError: JamBotError | undefined;
  /** Rejections for the next `connect`s, in order. */
  readonly connectErrors: JamBotError[] = [];
  /** Holds every `play` until opened. */
  playGate: Gate | undefined;
  /** Length of the files it plays (answered as `durationMs`). */
  fileDurationMs = 200_000;
  /** Where a `play` lands, from its offset (the real bot starts at the packet holding it). */
  landing: (offsetMs: number) => number = (offsetMs) => offsetMs;
  probeResult: BotProbeResult = {
    durationMs: 199_500,
    channels: 2,
    sampleRate: 48_000,
    codec: 'opus',
  };
  probeError: JamBotError | undefined;
  /** Rejection of the header-only probes (`partial`). */
  partialProbeError: JamBotError | undefined;
  /** Files that existed when probed, with their size then. */
  readonly probedFiles: string[] = [];
  readonly probedSizes: number[] = [];
  handlers: BotEventHandlers | undefined;
  stopped = false;

  private check(): void {
    if (this.unreachable) throw new JamBotError(0, 'unreachable', 'connect ECONNREFUSED');
  }

  callsOf(method: BotCall['method']): BotCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  plays(): { room: RoomId; request: BotPlayRequest }[] {
    return this.calls.flatMap((call) =>
      call.method === 'play' ? [{ room: call.room, request: call.request }] : [],
    );
  }

  async probe(file: string, options: BotProbeOptions = {}): Promise<BotProbeResult> {
    const partial = options.partial === true;
    this.calls.push({ method: 'probe', file, partial });
    this.check();
    const info = await stat(file);
    this.probedFiles.push(file);
    this.probedSizes.push(info.size);
    if (partial) {
      if (this.partialProbeError) throw this.partialProbeError;
      return { ...this.probeResult, durationMs: 0 };
    }
    if (this.probeError) throw this.probeError;
    return this.probeResult;
  }

  async connect(room: RoomId, request: BotConnectRequest): Promise<BotRoomStatus> {
    this.calls.push({ method: 'connect', room, request });
    this.check();
    const error = this.connectErrors.shift();
    if (error) throw error;
    let status = this.state.get(room);
    if (!status) {
      status = { room, itemId: '', state: 'idle', positionMs: 0, durationMs: 0 };
      this.state.set(room, status);
    }
    return { ...status };
  }

  async play(room: RoomId, request: BotPlayRequest): Promise<BotRoomStatus> {
    this.calls.push({ method: 'play', room, request });
    this.check();
    await this.playGate?.promise;
    if (this.playError) {
      const error = this.playError;
      this.playError = undefined;
      throw error;
    }
    // Like the real bot, a growing file is opened before the answer (it must still be there).
    if (request.growing) {
      await stat(request.file).catch(() => {
        throw new JamBotError(422, 'invalid_audio', 'file not found');
      });
    }
    // Like the real bot: nothing left after the offset of a whole file answers `ended` (no event).
    const ended = !request.growing && request.offsetMs >= this.fileDurationMs;
    const status: BotRoomStatus = {
      room,
      itemId: request.itemId,
      state: ended ? 'ended' : request.paused ? 'paused' : 'playing',
      positionMs: ended ? this.fileDurationMs : this.landing(request.offsetMs),
      durationMs: this.fileDurationMs,
    };
    this.state.set(room, status);
    this.files.set(room, request.file);
    return { ...status };
  }

  private toggle(room: RoomId, state: 'playing' | 'paused'): BotRoomStatus {
    const status = this.state.get(room);
    if (
      !status ||
      status.state === 'idle' ||
      status.state === 'ended' ||
      status.state === 'error'
    ) {
      throw new JamBotError(404, 'not_playing', 'nothing playing');
    }
    status.state = state;
    return { ...status };
  }

  async pause(room: RoomId): Promise<BotRoomStatus> {
    this.calls.push({ method: 'pause', room });
    this.check();
    return this.toggle(room, 'paused');
  }

  async resume(room: RoomId): Promise<BotRoomStatus> {
    this.calls.push({ method: 'resume', room });
    this.check();
    return this.toggle(room, 'playing');
  }

  async leave(room: RoomId): Promise<void> {
    this.calls.push({ method: 'leave', room });
    this.check();
    this.state.delete(room);
    this.files.delete(room);
  }

  async rooms(): Promise<BotRoomStatus[]> {
    this.calls.push({ method: 'rooms' });
    this.check();
    return [...this.state.values()].map((status) => ({ ...status }));
  }

  async completeFile(file: string): Promise<void> {
    this.calls.push({ method: 'complete', file });
    this.check();
  }

  /** Like the real bot: rooms playing the file stop, reporting `error` (a moment later). */
  async failFile(file: string): Promise<void> {
    this.calls.push({ method: 'failed', file });
    this.check();
    for (const [room, playing] of this.files) {
      const status = this.state.get(room);
      if (playing !== file || !status) continue;
      if (status.state !== 'playing' && status.state !== 'paused') continue;
      const { itemId } = status;
      setImmediate(() => this.emit({ type: 'error', room, itemId, message: 'upload failed' }));
    }
  }

  events(handlers: BotEventHandlers) {
    this.handlers = handlers;
    return {
      stop: () => {
        this.stopped = true;
      },
    };
  }

  /** The event stream (re)connected: the api reconciles. */
  async reconnect(): Promise<void> {
    if (!this.handlers) throw new Error('nobody follows the bot events');
    await this.handlers.onConnect();
  }

  /** The bot reports a song it finished (marking the room silent, like the real one). */
  emit(event: BotEvent): void {
    const status = this.state.get(event.room);
    if (status && status.itemId === event.itemId) status.state = event.type;
    this.handlers?.onEvent(event);
  }
}

export interface JamSetupOptions {
  /** Who is in each room (presence). */
  people?: Record<RoomId, string[]>;
  /**
   * Users whose desktop app can download (registered as fetchers, as a presence stream with
   * `?jam=1&fetch=1` would): they upload their own songs. Nobody by default.
   */
  downloaders?: string[];
  /** False: no bot (the Jam is unavailable). */
  withBot?: boolean;
  tracks?: JamTrack[];
  /** Persist the jam to a state file in the temporary directory (once started). */
  persist?: boolean;
  cacheMaxBytes?: number;
  /** Songs unused this long are deleted by the cache maintenance (default 0: never). */
  cacheTtlMs?: number;
  service?: Partial<JamServiceOptions>;
}

/** Everything logged, as text (errors with their message), to look for secrets. */
export function loggedText(log: ReturnType<typeof fakeLogger>): string {
  const calls = [log.debug, log.info, log.warn, log.error].flatMap((fn) => fn.mock.calls);
  return JSON.stringify(calls, (_key, value: unknown) =>
    value instanceof Error ? { ...value, name: value.name, message: value.message } : value,
  );
}

export interface JamSetup {
  service: JamService;
  bot: FakeBot;
  youtube: FakeYouTube;
  presence: PresenceStore;
  clock: FakeClock;
  cacheDir: string;
  stateFile: string;
  log: ReturnType<typeof fakeLogger>;
  /** Stops the service and builds a new one over the same files, bot and presence (a deploy). */
  restart(): Promise<JamService>;
  cleanup(): Promise<void>;
}

export const ROOMS = ['geral', 'jogos'];

/** A JamService over fakes, a real temporary cache directory and a deterministic id sequence. */
export async function jamSetup(options: JamSetupOptions = {}): Promise<JamSetup> {
  const dir = await mkdtemp(join(tmpdir(), 'concord-jam-'));
  const cacheDir = join(dir, 'cache');
  const stateFile = join(dir, 'jam-state.json');
  const clock = new FakeClock();
  const log = fakeLogger();
  const bot = new FakeBot();
  const youtube = new FakeYouTube(
    options.tracks ?? [track(VIDEO_A), track(VIDEO_B), track(VIDEO_C)],
  );
  const presence = new PresenceStore(ROOMS);
  for (const [room, ids] of Object.entries(options.people ?? { geral: ['alice', 'bob'] })) {
    for (const id of ids) presence.join(room, { id, name: id, joinedAt: 0 });
  }
  let nextId = 0;
  const build = (): JamService => {
    const service = new JamService({
      rooms: ROOMS,
      presence,
      youtube,
      bot: options.withBot === false ? undefined : bot,
      cache: new JamAudioCache(cacheDir, options.cacheMaxBytes ?? 1024 * 1024 * 1024, log, {
        ttlMs: options.cacheTtlMs,
      }),
      stateFile: options.persist ? stateFile : undefined,
      livekitUrl: 'ws://127.0.0.1:7880',
      botToken: async (room) => `token-${room}-${clock.now()}`,
      log,
      now: clock.now,
      newId: () => `item-${++nextId}`,
      retryDelay: () => 60_000,
      persistDebounceMs: 10,
      ...options.service,
    });
    for (const userId of options.downloaders ?? []) {
      service.fetchers.register({ userId, send: () => undefined });
    }
    return service;
  };
  const setup: JamSetup = {
    service: build(),
    bot,
    youtube,
    presence,
    clock,
    cacheDir,
    stateFile,
    log,
    async restart() {
      await setup.service.stop();
      setup.service = build();
      return setup.service;
    },
    async cleanup() {
      await setup.service.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return setup;
}

export type SseEvent = PresenceEvent | JamEvent | JamFetchEvent;

/** Collects the `data:` events of an SSE response as they arrive (until it is aborted). */
export function collectSse(body: ReadableStream<Uint8Array>): SseEvent[] {
  const events: SseEvent[] = [];
  void (async () => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)) as SseEvent);
          end = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted
    }
  })();
  return events;
}

/** A request body stream, like Fastify hands the upload route. */
export function audio(bytes = 1024): Readable {
  return Readable.from([Buffer.alloc(bytes, 7)]);
}

/** Puts a song's audio in the cache, as a finished upload would. */
export async function cacheSong(s: JamSetup, videoId: string, bytes = 100): Promise<void> {
  await mkdir(s.cacheDir, { recursive: true });
  await writeFile(join(s.cacheDir, `${videoId}.webm`), Buffer.alloc(bytes, 1));
}
