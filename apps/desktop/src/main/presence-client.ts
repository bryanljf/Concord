import {
  applyPresenceEvent,
  PRESENCE_JAM_QUERY,
  SSE_HEARTBEAT_MS,
  type PresenceEvent,
  type PresenceSnapshot,
} from '@concord/shared';
import type { ReadableStreamReadResult } from 'node:stream/web';
import type { PresenceConnectionStatus, PresenceState } from '../preload/api';
import {
  isTimeoutError,
  networkErrorMessage,
  normalizeServerUrl,
  RATE_LIMITED_MESSAGE,
  serverHost,
  timeoutErrorMessage,
  UNAUTHORIZED_MESSAGE,
  unexpectedStatusMessage,
} from './api-client';
import { isJamPayload, parseJamEvent } from './jam-events';
import { createJamStore, type JamStore } from './jam/store';
import { log } from './log';
import { parsePresenceEvent } from './presence-events';
import { createSseParser } from './sse-parser';

const logger = log('presence');

// ---------------------------------------------------------------------------
// Backoff
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

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type IdleReason = Extract<PresenceConnectionStatus, { state: 'idle' }>['reason'];

export interface PresenceClientOptions {
  getServerUrl(): string;
  getKey(): string | null;
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Abort a connection that stayed silent this long (default: 2 × SSE_HEARTBEAT_MS). */
  stallTimeoutMs?: number;
  /** Give up on a connection attempt that has not answered this long. */
  connectTimeoutMs?: number;
  backoff?: (attempt: number) => number;
  /** Where the jam events of the same stream go (default: a store of its own). */
  jam?: JamStore;
}

export type PresenceEventListener = (event: PresenceEvent) => void;
export type PresenceStatusListener = (status: PresenceConnectionStatus) => void;

const EMPTY_SNAPSHOT: PresenceSnapshot = { rooms: {} };

/** Aborts the in-flight request when the stream goes silent for too long. */
class StallSignal extends Error {
  override readonly name = 'StallSignal';
}

/**
 * Keeps one `GET /api/presence?jam=1` SSE connection alive while `connect()`ed, applying every
 * event to a local `PresenceSnapshot` and re-emitting it; the jam events of the same stream go
 * to `jam`. Reconnects with exponential backoff on any failure except 401, which stops retrying
 * (`retryInMs: 0`) until `reconnect()`.
 */
export class PresenceClient {
  /** The rooms' jams, fed by this stream (the server resends a snapshot on every connection). */
  readonly jam: JamStore;
  private status: PresenceConnectionStatus = { state: 'idle', reason: 'no_session' };
  private snapshot: PresenceSnapshot = EMPTY_SNAPSHOT;
  /** Server the jam store holds data from: switching servers drops it right away. */
  private jamServer: string | null = null;
  private attempt = 0;
  /** True between `connect()` and `disconnect()` (or a fatal error). */
  private active = false;
  /** Bumped on every connect/disconnect so stale async work can bail out. */
  private generation = 0;
  private controller: AbortController | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private readonly eventListeners = new Set<PresenceEventListener>();
  private readonly statusListeners = new Set<PresenceStatusListener>();
  private readonly fetchImpl: typeof fetch;
  private readonly stallTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly backoff: (attempt: number) => number;

  constructor(private readonly options: PresenceClientOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 2 * SSE_HEARTBEAT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.backoff = options.backoff ?? backoffDelay;
    this.jam = options.jam ?? createJamStore();
  }

  getStatus(): PresenceConnectionStatus {
    return this.status;
  }

  getSnapshot(): PresenceSnapshot {
    return this.snapshot;
  }

  getState(): PresenceState {
    return { status: this.status, snapshot: this.snapshot };
  }

  get isActive(): boolean {
    return this.active;
  }

  onEvent(listener: PresenceEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onStatus(listener: PresenceStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /** Starts connecting (no-op while already active). */
  connect(): void {
    if (this.active) return;
    this.active = true;
    this.attempt = 0;
    void this.openStream();
  }

  /** Drops the current connection (if any) and connects again right away with fresh credentials. */
  reconnect(): void {
    this.teardown();
    this.active = true;
    this.attempt = 0;
    void this.openStream();
  }

  disconnect(reason: IdleReason): void {
    this.teardown();
    this.active = false;
    if (this.snapshot !== EMPTY_SNAPSHOT) {
      // Let listeners clear stale data: the server will send a fresh snapshot on reconnect.
      this.snapshot = EMPTY_SNAPSHOT;
      this.emitEvent({ type: 'snapshot', data: EMPTY_SNAPSHOT });
    }
    this.jam.reset();
    this.jamServer = null;
    if (this.status.state !== 'idle' || this.status.reason !== reason) {
      this.setStatus({ state: 'idle', reason });
    }
  }

  // ---------------------------------------------------------------------------

  private teardown(): void {
    this.generation += 1;
    this.clearRetry();
    this.clearStall();
    this.controller?.abort();
    this.controller = null;
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private armStall(controller: AbortController): void {
    this.clearStall();
    this.stallTimer = setTimeout(() => {
      logger.warn(`no data for ${this.stallTimeoutMs} ms; reconnecting`);
      controller.abort(new StallSignal('stalled'));
    }, this.stallTimeoutMs);
  }

  private setStatus(status: PresenceConnectionStatus): void {
    this.status = status;
    logger.info(`status → ${describeStatus(status)}`);
    for (const listener of this.statusListeners) listener(status);
  }

  private emitEvent(event: PresenceEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  private async openStream(): Promise<void> {
    const generation = this.generation;
    this.attempt += 1;
    this.setStatus({ state: 'connecting', attempt: this.attempt });

    let base: string;
    try {
      base = normalizeServerUrl(this.options.getServerUrl());
    } catch (err) {
      this.fail(err instanceof Error ? err.message : 'URL do servidor inválida.');
      return;
    }
    const key = this.options.getKey();
    if (key === null) {
      this.fail('Nenhuma chave de acesso configurada.');
      return;
    }
    const host = serverHost(base);
    const controller = new AbortController();
    this.controller = controller;

    const connectTimer = setTimeout(() => {
      controller.abort(new DOMException('connect timeout', 'TimeoutError'));
    }, this.connectTimeoutMs);
    let res: Response;
    try {
      // Old servers ignore the query (no jam events): the jam then stays unavailable.
      res = await this.fetchImpl(`${base}/api/presence?${PRESENCE_JAM_QUERY}`, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(connectTimer);
      if (generation !== this.generation) return;
      this.scheduleRetry(
        isTimeoutError(err) || isTimeoutError(controller.signal.reason)
          ? timeoutErrorMessage(host)
          : networkErrorMessage(host),
      );
      return;
    }
    clearTimeout(connectTimer);
    if (generation !== this.generation) {
      void res.body?.cancel().catch(() => undefined);
      return;
    }
    if (res.status === 401) {
      void res.body?.cancel().catch(() => undefined);
      this.fail(UNAUTHORIZED_MESSAGE);
      return;
    }
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => undefined);
      this.scheduleRetry(
        res.status === 429 ? RATE_LIMITED_MESSAGE : unexpectedStatusMessage(res.status),
      );
      return;
    }

    this.attempt = 0;
    if (this.jamServer !== base) {
      // Another server's jam must not linger (it may not even have one).
      this.jam.reset();
      this.jamServer = base;
    }
    this.setStatus({ state: 'connected' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSseParser();
    this.armStall(controller);
    try {
      for (;;) {
        const { value, done } = await readOrAbort(reader, controller.signal);
        if (generation !== this.generation) return;
        if (done) break;
        this.armStall(controller);
        for (const payload of parser.feed(decoder.decode(value, { stream: true }))) {
          this.handlePayload(payload);
        }
      }
      this.clearStall();
      this.scheduleRetry('A conexão com o servidor foi encerrada.');
    } catch (err) {
      this.clearStall();
      if (generation !== this.generation) return;
      const stalled = controller.signal.reason instanceof StallSignal;
      this.scheduleRetry(
        stalled ? 'O servidor parou de responder.' : 'A conexão com o servidor caiu.',
      );
      if (!stalled) logger.warn('stream error', err);
    } finally {
      void reader.cancel().catch(() => undefined);
    }
  }

  private handlePayload(payload: string): void {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      logger.warn('ignoring non-JSON SSE payload');
      return;
    }
    if (isJamPayload(json)) {
      const jamEvent = parseJamEvent(json);
      if (jamEvent) this.jam.apply(jamEvent);
      else logger.warn('ignoring malformed jam event');
      return;
    }
    const event = parsePresenceEvent(json);
    if (!event) {
      logger.warn('ignoring malformed presence event');
      return;
    }
    this.snapshot = applyPresenceEvent(this.snapshot, event);
    this.emitEvent(event);
  }

  private scheduleRetry(message: string): void {
    this.controller = null;
    if (!this.active) return;
    // `attempt` is 0 right after a successful connection: a dropped stream retries like attempt 1.
    const retryInMs = this.backoff(Math.max(1, this.attempt));
    this.setStatus({ state: 'error', message, retryInMs });
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.openStream();
    }, retryInMs);
  }

  /** Terminal error: stays `error` with `retryInMs: 0` until `reconnect()` or `disconnect()`. */
  private fail(message: string): void {
    this.teardown();
    this.active = false;
    this.setStatus({ state: 'error', message, retryInMs: 0 });
  }
}

/**
 * `reader.read()` that also rejects when `signal` aborts, so a stalled or torn-down stream never
 * leaves the loop hanging even if the fetch implementation does not error the body itself.
 */
function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
  });
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
