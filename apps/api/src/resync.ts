import { fetchRoomState, type RoomServiceLike } from './livekit';
import type { Logger } from './logger';
import type { PresenceStore } from './presence-store';

export interface ResyncOptions {
  presence: PresenceStore;
  roomService: RoomServiceLike;
  log: Logger;
  /** Time between resyncs once the first one succeeded. */
  intervalMs?: number;
  /** Delay before the first attempt. */
  initialDelayMs?: number;
}

export interface Resync {
  stop(): void;
}

const MAX_RETRY_DELAY_MS = 30_000;

/** Retry delay before the first successful resync: 1 s, 2 s, 4 s, … capped at 30 s. */
export function retryDelayMs(failures: number): number {
  return Math.min(1000 * 2 ** (failures - 1), MAX_RETRY_DELAY_MS);
}

/**
 * Periodically reconciles the presence store with the LiveKit server, so presence survives
 * api restarts and missed webhooks. Failures are logged once per streak, not on every retry.
 */
export function startResync(options: ResyncOptions): Resync {
  const { presence, roomService, log, intervalMs = 60_000, initialDelayMs = 0 } = options;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let failures = 0;
  let synced = false;

  function schedule(delayMs: number): void {
    if (!stopped) timer = setTimeout(run, delayMs);
  }

  async function run(): Promise<void> {
    timer = undefined;
    try {
      const state = await fetchRoomState(roomService);
      if (stopped) return;
      presence.replaceAll(state);
      if (failures > 0) log.info({ failures }, 'LiveKit presence resync recovered');
      failures = 0;
      synced = true;
      schedule(intervalMs);
    } catch (err) {
      if (stopped) return;
      failures += 1;
      if (failures === 1) log.warn({ err }, 'LiveKit presence resync failed, retrying');
      schedule(synced ? intervalMs : retryDelayMs(failures));
    }
  }

  schedule(initialDelayMs);
  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
