import type { RoomId } from '@concord/shared';
import type { FetchLike } from '../discord-sync';
import type { Logger } from '../logger';
import { retryDelayMs } from '../resync';

// Types of the bot's internal API (apps/jam-bot/API.md).

/** `idle`: in the room (joined via `connect`), nothing loaded yet; its itemId is ''. */
export type BotRoomState = 'idle' | 'playing' | 'paused' | 'ended' | 'error';

export interface BotRoomStatus {
  room: RoomId;
  itemId: string;
  state: BotRoomState;
  /** Where playback is right now. */
  positionMs: number;
  /** From the file (so far, while it is still growing). */
  durationMs: number;
  /** With state "error". */
  message?: string;
}

export interface BotProbeResult {
  durationMs: number;
  channels: number;
  sampleRate: number;
  codec: string;
}

export interface BotConnectRequest {
  livekitUrl: string;
  token: string;
}

export interface BotPlayRequest extends BotConnectRequest {
  itemId: string;
  /** Absolute path inside JAM_CACHE_DIR. */
  file: string;
  offsetMs: number;
  paused: boolean;
  /** The file is still being written (a streaming upload): the bot waits for more at its end. */
  growing?: boolean;
}

export interface BotProbeOptions {
  /** Only the header (the file may still be growing): `durationMs` comes back 0. */
  partial?: boolean;
}

export type BotEvent =
  | { type: 'ended'; room: RoomId; itemId: string }
  | { type: 'error'; room: RoomId; itemId: string; message: string };

export interface BotEventHandlers {
  /** Runs on every (re)connection, once events flow; a rejection drops the connection. */
  onConnect(): Promise<void>;
  onEvent(event: BotEvent): void;
}

export interface BotEventStream {
  stop(): void;
}

/** The jam bot, as the api drives it (faked in tests). */
export interface JamBot {
  probe(file: string, options?: BotProbeOptions): Promise<BotProbeResult>;
  /** Joins `room` ahead of its first song (silent track); keeps playing if it already is. */
  connect(room: RoomId, request: BotConnectRequest): Promise<BotRoomStatus>;
  /** Plays `itemId` from `offsetMs` (paused or not), replacing whatever the room played. */
  play(room: RoomId, request: BotPlayRequest): Promise<BotRoomStatus>;
  pause(room: RoomId): Promise<BotRoomStatus>;
  resume(room: RoomId): Promise<BotRoomStatus>;
  /** Stops and leaves the room (idempotent). */
  leave(room: RoomId): Promise<void>;
  rooms(): Promise<BotRoomStatus[]>;
  /** A file played with `growing: true` is whole: rooms playing it go on to its real end. */
  completeFile(file: string): Promise<void>;
  /** A file played with `growing: true` will never be whole: rooms playing it stop (`error`). */
  failFile(file: string): Promise<void>;
  /** Streams `GET /v1/events` until stopped, reconnecting with backoff. */
  events(handlers: BotEventHandlers): BotEventStream;
}

/**
 * A failed call to the bot. `status` 0: the bot could not be reached (refused, timed out); else
 * its HTTP status, with the `error` code it answered.
 */
export class JamBotError extends Error {
  override name = 'JamBotError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /** Down or failing on its side (worth retrying), as opposed to rejecting the request. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface JamBotClientOptions {
  /** `JAM_BOT_URL`, without a trailing slash. */
  baseUrl: string;
  /** `JAM_BOT_TOKEN`: sent as `Authorization: Bearer` when set. */
  token?: string;
  log: Logger;
  fetch?: FetchLike;
  /**
   * `PUT /v1/rooms/{room}` and `POST /v1/rooms/{room}/connect` join LiveKit first: they get longer
   * (default 15 s).
   */
  playTimeoutMs?: number;
  /** Everything else (default 5 s; probing reads the file, so it gets playTimeoutMs too). */
  timeoutMs?: number;
  /** The bot pings every 15 s: a stream silent for this long is dropped (default 45 s). */
  idleTimeoutMs?: number;
  /** Delay before reconnecting after the n-th consecutive failure (default resync's backoff). */
  retryDelay?: (failures: number) => number;
}

const STATES: ReadonlySet<string> = new Set<BotRoomState>([
  'idle',
  'playing',
  'paused',
  'ended',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function invalidResponse(what: string): JamBotError {
  return new JamBotError(502, 'invalid_response', `jam bot sent an invalid ${what}`);
}

export function parseBotRoomStatus(value: unknown): BotRoomStatus {
  if (!isRecord(value)) throw invalidResponse('room status');
  const { room, itemId, state, positionMs, durationMs, message } = value;
  if (typeof room !== 'string' || typeof itemId !== 'string' || typeof state !== 'string') {
    throw invalidResponse('room status');
  }
  if (!STATES.has(state) || !isNumber(positionMs) || !isNumber(durationMs)) {
    throw invalidResponse('room status');
  }
  return {
    room,
    itemId,
    state: state as BotRoomState,
    positionMs,
    durationMs,
    ...(typeof message === 'string' ? { message } : {}),
  };
}

export function parseBotEvent(value: unknown): BotEvent | undefined {
  if (!isRecord(value)) return undefined;
  const { type, room, itemId, message } = value;
  if (typeof room !== 'string' || typeof itemId !== 'string') return undefined;
  if (type === 'ended') return { type, room, itemId };
  if (type === 'error') return { type, room, itemId, message: String(message ?? '').slice(0, 200) };
  return undefined;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Reads a Server-Sent Events body: calls `onChunk` for every chunk received (pings included) and
 * `onData` with the `data:` of every event.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: string) => void,
  onChunk: () => void = () => undefined,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      onChunk();
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''));
        if (data.length > 0) onData(data.join('\n'));
        end = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** HTTP client of the jam bot. Never logs the bot token nor the LiveKit tokens it sends. */
export function createJamBotClient(options: JamBotClientOptions): JamBot {
  const {
    baseUrl,
    token,
    log,
    fetch: fetchImpl = (input, init) => fetch(input, init),
    playTimeoutMs = 15_000,
    timeoutMs = 5_000,
    idleTimeoutMs = 45_000,
    retryDelay = retryDelayMs,
  } = options;
  const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const roomPath = (room: RoomId): string => `/v1/rooms/${encodeURIComponent(room)}`;

  async function call(
    method: string,
    path: string,
    body?: object,
    limitMs = timeoutMs,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: body ? { ...auth, 'content-type': 'application/json' } : auth,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(limitMs),
      });
    } catch (err) {
      throw new JamBotError(0, 'unreachable', `${method} ${path} failed: ${describe(err)}`);
    }
    let payload: unknown;
    try {
      payload = response.status === 204 ? undefined : await response.json();
    } catch {
      if (response.ok) throw invalidResponse(`answer to ${method} ${path}`);
    }
    if (!response.ok) {
      const code =
        isRecord(payload) && typeof payload.error === 'string'
          ? payload.error.slice(0, 64)
          : 'error';
      const detail =
        isRecord(payload) && typeof payload.message === 'string'
          ? payload.message.slice(0, 200)
          : '';
      throw new JamBotError(
        response.status,
        code,
        `${method} ${path} answered ${response.status} ${code}${detail ? `: ${detail}` : ''}`,
      );
    }
    return payload;
  }

  return {
    async probe(file, probeOptions = {}) {
      const body = probeOptions.partial ? { file, partial: true } : { file };
      const result = await call('POST', '/v1/probe', body, playTimeoutMs);
      if (!isRecord(result) || !isNumber(result.durationMs)) throw invalidResponse('probe result');
      return {
        durationMs: result.durationMs,
        channels: isNumber(result.channels) ? result.channels : 0,
        sampleRate: isNumber(result.sampleRate) ? result.sampleRate : 0,
        codec: typeof result.codec === 'string' ? result.codec : '',
      };
    },

    async connect(room, request) {
      const body = { livekitUrl: request.livekitUrl, token: request.token };
      const path = `${roomPath(room)}/connect`;
      return parseBotRoomStatus(await call('POST', path, body, playTimeoutMs));
    },

    async play(room, request) {
      return parseBotRoomStatus(await call('PUT', roomPath(room), request, playTimeoutMs));
    },

    async pause(room) {
      return parseBotRoomStatus(await call('POST', `${roomPath(room)}/pause`));
    },

    async resume(room) {
      return parseBotRoomStatus(await call('POST', `${roomPath(room)}/resume`));
    },

    async leave(room) {
      await call('DELETE', roomPath(room));
    },

    async rooms() {
      const result = await call('GET', '/v1/rooms');
      if (!isRecord(result) || !Array.isArray(result.rooms)) throw invalidResponse('room list');
      return result.rooms.map(parseBotRoomStatus);
    },

    async completeFile(file) {
      await call('POST', '/v1/files/complete', { file });
    },

    async failFile(file) {
      await call('POST', '/v1/files/failed', { file });
    },

    events(handlers) {
      const controller = new AbortController();
      const { signal } = controller;
      let failures = 0;

      function dispatch(data: string): void {
        let event: BotEvent | undefined;
        try {
          event = parseBotEvent(JSON.parse(data));
        } catch {
          event = undefined;
        }
        if (!event) {
          log.warn({ data: data.slice(0, 200) }, 'ignoring an invalid jam bot event');
          return;
        }
        try {
          handlers.onEvent(event);
        } catch (err) {
          log.error({ err, event }, 'jam bot event handler failed');
        }
      }

      async function connectOnce(): Promise<void> {
        const attempt = new AbortController();
        const abort = (): void => attempt.abort();
        signal.addEventListener('abort', abort, { once: true });
        let idle: NodeJS.Timeout | undefined;
        const arm = (): void => {
          clearTimeout(idle);
          idle = setTimeout(() => attempt.abort(), idleTimeoutMs);
        };
        try {
          arm();
          let response: Response;
          try {
            response = await fetchImpl(`${baseUrl}/v1/events`, {
              headers: { ...auth, accept: 'text/event-stream' },
              signal: attempt.signal,
            });
          } catch (err) {
            throw new JamBotError(0, 'unreachable', `GET /v1/events failed: ${describe(err)}`);
          }
          if (!response.ok || !response.body) {
            throw new JamBotError(
              response.status,
              'error',
              `GET /v1/events answered ${response.status}`,
            );
          }
          if (failures > 0) log.info({ failures }, 'jam bot event stream reconnected');
          failures = 0;
          const reading = readSse(response.body, dispatch, arm);
          reading.catch(() => undefined);
          try {
            await handlers.onConnect();
          } catch (err) {
            attempt.abort();
            throw err;
          }
          await reading;
          if (!signal.aborted) log.info({}, 'jam bot event stream closed, reconnecting');
        } finally {
          clearTimeout(idle);
          signal.removeEventListener('abort', abort);
          attempt.abort();
        }
      }

      void (async () => {
        while (!signal.aborted) {
          try {
            await connectOnce();
          } catch (err) {
            if (signal.aborted) break;
            failures += 1;
            if (failures === 1) {
              log.warn({ err: describe(err) }, 'jam bot event stream failed, retrying');
            }
          }
          await sleep(retryDelay(Math.max(failures, 1)), signal);
        }
      })();

      return {
        stop(): void {
          controller.abort();
        },
      };
    },
  };
}
