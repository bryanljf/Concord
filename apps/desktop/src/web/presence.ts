/**
 * `GET /api/presence?jam=1` over `EventSource`, kept alive while someone is logged in, applying
 * every event to a local `PresenceSnapshot` (and the jam events to a `JamStore`) exactly like
 * `main/presence-client.ts`. The browser parses the stream; this module owns the reconnection
 * (same backoff as main, instead of the browser's fixed retry) and the phone's quirks: a page in
 * the background loses its socket, so it reconnects when shown again.
 */
import {
  applyPresenceEvent,
  PRESENCE_JAM_QUERY,
  SSE_HEARTBEAT_MS,
  type PresenceEvent,
  type PresenceSnapshot,
} from '@concord/shared';
import { isJamPayload, parseJamEvent } from '../main/jam-events';
import { createJamStore, type JamStore } from '../main/jam/store';
import { parsePresenceEvent } from '../main/presence-events';
import type { PresenceConnectionStatus, PresenceState } from '../preload/api';
import { networkErrorMessage } from './http';
import { log } from './log';

const logger = log('presence');

export const PRESENCE_URL = `/api/presence?${PRESENCE_JAM_QUERY}`;

// ---------------------------------------------------------------------------
// Backoff (the desktop's numbers)
// ---------------------------------------------------------------------------

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
export const BACKOFF_JITTER = 0.2;

/**
 * Delay before reconnection attempt `attempt` (1-based): 1 s, 2 s, 4 s … capped at 30 s, with
 * ±20% jitter, always clamped to [1 s, 30 s].
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 10));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** exponent);
  const jittered = base * (1 + (random() * 2 - 1) * BACKOFF_JITTER);
  return Math.round(Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, jittered)));
}

/**
 * Hidden at least this long (two missed heartbeats), the page may have been frozen by the phone
 * with its socket silently gone: it reconnects when shown again instead of trusting it.
 */
export const STALE_AFTER_HIDDEN_MS = 2 * SSE_HEARTBEAT_MS;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** The part of `EventSource` used here (tests pass a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

/** The part of `document` used here. */
export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export type IdleReason = Extract<PresenceConnectionStatus, { state: 'idle' }>['reason'];
export type PresenceEventListener = (event: PresenceEvent) => void;
export type PresenceStatusListener = (status: PresenceConnectionStatus) => void;

export interface WebPresenceOptions {
  /** Shown in error messages (`location.host`). */
  host: string;
  createEventSource(url: string): EventSourceLike;
  backoff?: (attempt: number) => number;
  visibility?: VisibilitySource | null;
  now?: () => number;
  /**
   * The server refused a connection before it opened. `EventSource` hides the status, so the
   * caller checks whether the session is still good (a 401 means it is not).
   */
  onRefused?: () => void;
  /** Where the jam events of the same stream go (default: a store of its own). */
  jam?: JamStore;
}

export interface WebPresence {
  /** The rooms' jams, fed by this stream (the server resends a snapshot on every connection). */
  readonly jam: JamStore;
  getState(): PresenceState;
  onEvent(listener: PresenceEventListener): () => void;
  onStatus(listener: PresenceStatusListener): () => void;
  /** Starts connecting (no-op while already active). */
  connect(): void;
  /** Drops the current connection (if any) and connects again right away. */
  reconnect(): void;
  disconnect(reason: IdleReason): void;
  /** Stops watching the page's visibility (tests). */
  dispose(): void;
}

const EMPTY_SNAPSHOT: PresenceSnapshot = { rooms: {} };

export function createWebPresence(options: WebPresenceOptions): WebPresence {
  const backoff = options.backoff ?? backoffDelay;
  const now = options.now ?? Date.now;
  const jam = options.jam ?? createJamStore();
  const visibility = options.visibility ?? null;
  const eventListeners = new Set<PresenceEventListener>();
  const statusListeners = new Set<PresenceStatusListener>();

  let status: PresenceConnectionStatus = { state: 'idle', reason: 'no_session' };
  let snapshot = EMPTY_SNAPSHOT;
  let attempt = 0;
  /** True between `connect()` and `disconnect()`. */
  let active = false;
  /** The live connection; null while waiting for a retry. */
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the page was hidden; null while visible. */
  let hiddenAt: number | null = null;

  function setStatus(next: PresenceConnectionStatus): void {
    status = next;
    logger.info(`status → ${describeStatus(next)}`);
    for (const listener of statusListeners) listener(next);
  }

  function emitEvent(event: PresenceEvent): void {
    for (const listener of eventListeners) listener(event);
  }

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function closeSource(): void {
    if (source === null) return;
    source.onopen = null;
    source.onmessage = null;
    source.onerror = null;
    source.close();
    source = null;
  }

  function teardown(): void {
    clearRetry();
    closeSource();
  }

  function open(): void {
    attempt += 1;
    setStatus({ state: 'connecting', attempt });
    let next: EventSourceLike;
    try {
      next = options.createEventSource(PRESENCE_URL);
    } catch (err) {
      logger.warn('could not open the presence stream', err);
      scheduleRetry(networkErrorMessage(options.host));
      return;
    }
    source = next;
    let opened = false;
    next.onopen = () => {
      if (source !== next) return;
      opened = true;
      attempt = 0;
      setStatus({ state: 'connected' });
    };
    next.onmessage = (event) => {
      if (source !== next) return;
      handlePayload(event.data);
    };
    next.onerror = () => {
      if (source !== next) return;
      closeSource();
      if (opened) {
        scheduleRetry('A conexão com o servidor caiu.');
        return;
      }
      // Refused (or unreachable) before it opened: maybe the cookie expired.
      options.onRefused?.();
      scheduleRetry(networkErrorMessage(options.host));
    };
  }

  function handlePayload(data: unknown): void {
    if (typeof data !== 'string') return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      logger.warn('ignoring non-JSON SSE payload');
      return;
    }
    if (isJamPayload(json)) {
      const jamEvent = parseJamEvent(json);
      if (jamEvent) jam.apply(jamEvent);
      else logger.warn('ignoring malformed jam event');
      return;
    }
    const event = parsePresenceEvent(json);
    if (!event) {
      logger.warn('ignoring malformed presence event');
      return;
    }
    snapshot = applyPresenceEvent(snapshot, event);
    emitEvent(event);
  }

  function scheduleRetry(message: string): void {
    if (!active) return;
    // `attempt` is 0 right after a successful connection: a dropped stream retries like attempt 1.
    const retryInMs = backoff(Math.max(1, attempt));
    setStatus({ state: 'error', message, retryInMs });
    clearRetry();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, retryInMs);
  }

  function restart(): void {
    teardown();
    attempt = 0;
    open();
  }

  function onVisibilityChange(): void {
    if (visibility === null) return;
    if (visibility.hidden) {
      hiddenAt = now();
      return;
    }
    const hiddenFor = hiddenAt === null ? 0 : Math.max(0, now() - hiddenAt);
    hiddenAt = null;
    if (!active) return;
    if (source === null) {
      logger.info('page visible again; reconnecting now');
      restart();
    } else if (hiddenFor >= STALE_AFTER_HIDDEN_MS) {
      logger.info(`page visible after ${Math.round(hiddenFor / 1000)} s hidden; reconnecting`);
      restart();
    }
  }

  visibility?.addEventListener('visibilitychange', onVisibilityChange);

  return {
    jam,
    getState: () => ({ status, snapshot }),
    onEvent(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },
    onStatus(listener) {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    connect() {
      if (active) return;
      active = true;
      attempt = 0;
      open();
    },
    reconnect() {
      active = true;
      restart();
    },
    disconnect(reason) {
      teardown();
      active = false;
      if (snapshot !== EMPTY_SNAPSHOT) {
        // Let listeners clear stale data: the server will send a fresh snapshot on reconnect.
        snapshot = EMPTY_SNAPSHOT;
        emitEvent({ type: 'snapshot', data: EMPTY_SNAPSHOT });
      }
      jam.reset();
      if (status.state !== 'idle' || status.reason !== reason) {
        setStatus({ state: 'idle', reason });
      }
    },
    dispose() {
      visibility?.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

export function describeStatus(status: PresenceConnectionStatus): string {
  switch (status.state) {
    case 'idle':
      return `idle (${status.reason})`;
    case 'connecting':
      return `connecting (attempt ${status.attempt})`;
    case 'connected':
      return 'connected';
    case 'error':
      return `error "${status.message}"${status.retryInMs > 0 ? ` retry in ${status.retryInMs} ms` : ' (no retry)'}`;
  }
}
