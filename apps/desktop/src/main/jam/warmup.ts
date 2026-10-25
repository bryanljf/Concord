/**
 * The yt-dlp warm-up: once per run of the app, on Windows, as soon as the jam is available, check
 * yt-dlp in the background (the daily update included) and run `yt-dlp --version` once, so the
 * first song added does not pay for the cold start (the binary and its libraries read from disk
 * and scanned by the antivirus: ~1 s). It never fetches a yt-dlp that is not installed (the first
 * search does that) and never counts as a use. It takes a yt-dlp process slot like a prefetch,
 * so an added song stops it. Electron-free.
 */
import { log } from '../log';
import type { YtDlpSlots } from './slots';
import type { JamStore } from './store';
import type { YtDlpManager } from './ytdlp';

const logger = log('yt-dlp');

export interface JamWarmUpDeps {
  store: Pick<JamStore, 'get' | 'onEvent'>;
  /** Windows only (yt-dlp runs nowhere else). */
  enabled: boolean;
  ytdlp: Pick<YtDlpManager, 'warmUp'>;
  slots: Pick<YtDlpSlots, 'acquire'>;
  /** Runs `yt-dlp --version` (null when it did not work); stops when `signal` aborts. */
  runVersion(exePath: string, signal: AbortSignal): Promise<string | null>;
}

export interface JamWarmUp {
  /** Resolves once the warm-up ran (or was skipped); for tests and logs. */
  readonly done: Promise<void>;
  destroy(): void;
}

export function createJamWarmUp(deps: JamWarmUpDeps): JamWarmUp {
  const lifetime = new AbortController();
  let started = false;
  let unsubscribe: (() => void) | null = null;
  let markDone!: () => void;
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });

  async function warm(): Promise<void> {
    const binary = await deps.ytdlp.warmUp();
    if (!binary || lifetime.signal.aborted) return;
    // Stopped by quit, or by an added song that needs the process slot.
    const stop = new AbortController();
    const onQuit = (): void => stop.abort();
    lifetime.signal.addEventListener('abort', onQuit, { once: true });
    try {
      const slot = await deps.slots.acquire('prefetch', stop.signal, () => stop.abort());
      try {
        const startedAt = Date.now();
        const version = await deps.runVersion(binary.path, stop.signal);
        if (version !== null) {
          logger.info(`yt-dlp ${version} warmed up (${Date.now() - startedAt} ms)`);
        }
      } finally {
        slot.release();
      }
    } finally {
      lifetime.signal.removeEventListener('abort', onQuit);
    }
  }

  function trigger(): void {
    if (started || !deps.store.get().available) return;
    started = true;
    unsubscribe?.();
    unsubscribe = null;
    warm()
      .catch((err: unknown) => {
        if (!lifetime.signal.aborted) logger.warn('yt-dlp warm-up failed', err);
      })
      .finally(markDone);
  }

  if (deps.enabled) {
    unsubscribe = deps.store.onEvent(trigger);
    trigger();
  } else {
    markDone();
  }

  return {
    done,
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
      lifetime.abort();
      if (!started) markDone();
    },
  };
}
