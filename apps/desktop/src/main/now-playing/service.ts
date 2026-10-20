/**
 * What the supported music apps play and whether they run, for `getMusicAppStatus` /
 * `onMusicAppStatus` / `getMusicArt`. The SMTC reader lives in a utility process (the worker),
 * started on the first `getStatus` and kept running (restarted with backoff if it crashes); the
 * app's process is polled with `tasklist` meanwhile. Electron-free: `index.ts` wires the real
 * utility process, `tasklist` and `nativeImage`.
 */
import type { MusicAppId, MusicAppStatus } from '../../preload/api';
import { log } from '../log';
import { MUSIC_APP_IDS, MUSIC_APPS, musicAppFromAumid } from '../music-apps';
import { ART_CACHE_SIZE, LruCache } from './art';
import {
  ART_ID_PATTERN,
  parseWorkerMessage,
  type MainMessage,
  type SessionSnapshot,
} from './protocol';
import { buildNowPlaying, musicStatusChanged, pickSession } from './snapshot';

const logger = log('now-playing');

/** How often the music apps' processes are looked for (only while they have no media session). */
export const PROCESS_POLL_INTERVAL_MS = 5_000;
/** The first `getStatus` waits this long at most for the worker and the process check. */
export const FIRST_REPORT_TIMEOUT_MS = 2_000;
/** Delay before each restart of a crashed worker; the last one repeats. */
export const RESTART_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000, 60_000];
/** A worker that ran this long before crashing restarts from the first delay again. */
export const STABLE_RUN_MS = 60_000;
/** Covers that failed to decode are not retried; the set is reset past this size. */
const BAD_ART_LIMIT = 100;

/** The utility process, as the service needs it (faked in tests). */
export interface NowPlayingWorker {
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  postMessage(message: MainMessage): void;
  kill(): void;
}

export interface NowPlayingServiceDeps {
  /** Whether SMTC and the process polling exist at all (Windows only). */
  supported: boolean;
  spawnWorker: () => NowPlayingWorker;
  /** Whether a process named one of `names` runs; rejects when the listing fails. */
  isRunning: (names: readonly string[]) => Promise<boolean>;
  /** Cover bytes → small JPEG data URL, null when undecodable. */
  encodeArt: (bytes: Uint8Array) => string | null;
  now?: () => number;
  pollIntervalMs?: number;
  firstReportTimeoutMs?: number;
  restartDelaysMs?: readonly number[];
}

export interface NowPlayingService {
  /** Starts watching on the first call; waits briefly for the first report. */
  getStatus(app: MusicAppId): Promise<MusicAppStatus>;
  /** Meaningful changes only (never every timeline tick). Does not start watching by itself. */
  onStatus(listener: (status: MusicAppStatus) => void): () => void;
  /** The cover for `NowPlaying.artId` as a JPEG data URL; null when unknown. */
  getArt(artId: string): string | null;
  destroy(): void;
}

interface AppState {
  /** Last process poll result (a media session also proves the app runs). */
  processRunning: boolean;
  session: SessionSnapshot | null;
  /** Current status (what `getStatus` answers). */
  status: MusicAppStatus;
  /** Last status pushed to listeners (what the renderer extrapolates from). */
  pushed: MusicAppStatus | null;
}

export function createNowPlayingService(deps: NowPlayingServiceDeps): NowPlayingService {
  const now = deps.now ?? Date.now;
  const pollIntervalMs = deps.pollIntervalMs ?? PROCESS_POLL_INTERVAL_MS;
  const firstReportTimeoutMs = deps.firstReportTimeoutMs ?? FIRST_REPORT_TIMEOUT_MS;
  const restartDelaysMs = deps.restartDelaysMs ?? RESTART_DELAYS_MS;

  const apps = Object.fromEntries(
    MUSIC_APP_IDS.map((app): [MusicAppId, AppState] => [
      app,
      { processRunning: false, session: null, status: idle(app), pushed: null },
    ]),
  ) as Record<MusicAppId, AppState>;
  const listeners = new Set<(status: MusicAppStatus) => void>();
  const art = new LruCache<string>(ART_CACHE_SIZE);
  const badArt = new Set<string>();

  let started = false;
  let destroyed = false;
  /** No worker on this platform, or it reported that SMTC cannot run here. */
  let workerUnavailable = !deps.supported;
  let worker: NowPlayingWorker | null = null;
  let workerStartedAt = 0;
  let restartAttempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  let listingFailed = false;

  let processChecked = !deps.supported;
  let workerReported = workerUnavailable;
  let firstReported = false;
  let resolveFirstReport: () => void = () => undefined;
  const firstReport = new Promise<void>((resolve) => {
    resolveFirstReport = resolve;
  });

  function idle(app: MusicAppId): MusicAppStatus {
    return { app, running: false, nowPlaying: null };
  }

  function maybeFirstReport(): void {
    if (firstReported || !processChecked || !workerReported) return;
    firstReported = true;
    resolveFirstReport();
  }

  function emit(status: MusicAppStatus): void {
    for (const listener of listeners) {
      try {
        listener(status);
      } catch (err) {
        logger.warn('music status listener failed', err);
      }
    }
  }

  /** The cover main can serve for `artId`; asks the worker again for a cover it lacks. */
  function servableArt(artId: string | null): string | null {
    if (artId === null) return null;
    if (art.has(artId)) return artId;
    if (!badArt.has(artId)) worker?.postMessage({ type: 'forget-art', artId });
    return null;
  }

  function refresh(app: MusicAppId): void {
    const state = apps[app];
    const nowPlaying = state.session
      ? buildNowPlaying(
          app,
          state.session,
          state.status.nowPlaying,
          servableArt(state.session.artId),
          now(),
        )
      : null;
    const next: MusicAppStatus = {
      app,
      running: state.processRunning || state.session !== null,
      nowPlaying,
    };
    state.status = next;
    if (!musicStatusChanged(state.pushed, next)) return;
    state.pushed = next;
    emit(next);
  }

  async function checkProcesses(): Promise<void> {
    if (checking || destroyed || !deps.supported) return;
    checking = true;
    try {
      for (const app of MUSIC_APP_IDS) {
        const state = apps[app];
        // A media session already proves the app runs: no need to spawn tasklist.
        if (state.session) {
          state.processRunning = true;
          continue;
        }
        try {
          state.processRunning = await deps.isRunning(MUSIC_APPS[app].processNames);
          listingFailed = false;
        } catch (err) {
          if (!listingFailed) logger.warn('could not list the music app processes', err);
          listingFailed = true;
        }
        if (!destroyed) refresh(app);
      }
    } finally {
      checking = false;
      processChecked = true;
      maybeFirstReport();
    }
  }

  function onSessions(sessions: readonly SessionSnapshot[]): void {
    const byApp = new Map<MusicAppId, SessionSnapshot[]>();
    for (const session of sessions) {
      const app = musicAppFromAumid(session.sourceAppId);
      if (!app) continue;
      byApp.set(app, [...(byApp.get(app) ?? []), session]);
    }
    let lostSession = false;
    for (const app of MUSIC_APP_IDS) {
      const state = apps[app];
      const session = pickSession(byApp.get(app) ?? []);
      if (state.session && !session) lostSession = true;
      state.session = session;
      if (session) state.processRunning = true;
      refresh(app);
    }
    workerReported = true;
    maybeFirstReport();
    // A session going away usually means the app closed: check now rather than in 5 s.
    if (lostSession) void checkProcesses();
  }

  function onArt(artId: string, bytes: Uint8Array): void {
    if (art.has(artId) || badArt.has(artId)) return;
    const url = deps.encodeArt(bytes);
    if (url) {
      art.set(artId, url);
      return;
    }
    if (badArt.size >= BAD_ART_LIMIT) badArt.clear();
    badArt.add(artId);
    logger.warn(`cover ${artId} (${bytes.byteLength} bytes) could not be decoded`);
  }

  function clearSessions(): void {
    for (const app of MUSIC_APP_IDS) {
      if (!apps[app].session) continue;
      apps[app].session = null;
      refresh(app);
    }
  }

  function stopWorker(): void {
    const current = worker;
    worker = null;
    current?.kill();
  }

  function handleMessage(raw: unknown): void {
    const message = parseWorkerMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'sessions':
        onSessions(message.sessions);
        break;
      case 'art':
        onArt(message.artId, message.bytes);
        break;
      case 'unavailable':
        logger.warn(`now playing unavailable: ${message.reason}`);
        workerUnavailable = true;
        stopWorker();
        clearSessions();
        workerReported = true;
        maybeFirstReport();
        break;
      case 'log':
        logger[message.level](`worker: ${message.message}`);
        break;
    }
  }

  function onWorkerExit(code: number): void {
    worker = null;
    if (destroyed || workerUnavailable) return;
    if (now() - workerStartedAt >= STABLE_RUN_MS) restartAttempt = 0;
    const delay =
      restartDelaysMs[Math.min(restartAttempt, restartDelaysMs.length - 1)] ?? STABLE_RUN_MS;
    restartAttempt += 1;
    logger.warn(`now-playing worker exited (code ${code}); restarting in ${delay} ms`);
    // Nothing is known until the new worker reports.
    clearSessions();
    workerReported = true;
    maybeFirstReport();
    void checkProcesses();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      spawn();
    }, delay);
  }

  function spawn(): void {
    if (destroyed || workerUnavailable) return;
    let current: NowPlayingWorker;
    try {
      current = deps.spawnWorker();
    } catch (err) {
      logger.error('could not start the now-playing worker', err);
      workerUnavailable = true;
      workerReported = true;
      maybeFirstReport();
      return;
    }
    worker = current;
    workerStartedAt = now();
    current.onMessage((message) => {
      if (worker === current) handleMessage(message);
    });
    current.onExit((code) => {
      if (worker === current) onWorkerExit(code);
    });
    logger.info('now-playing worker started');
  }

  function ensureStarted(): void {
    if (started || destroyed) return;
    started = true;
    spawn();
    if (deps.supported) {
      void checkProcesses();
      pollTimer = setInterval(() => void checkProcesses(), pollIntervalMs);
    }
    maybeFirstReport();
  }

  return {
    async getStatus(app) {
      ensureStarted();
      if (!firstReported) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, firstReportTimeoutMs);
          void firstReport.then(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return apps[app].status;
    },
    onStatus(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getArt(artId) {
      if (!ART_ID_PATTERN.test(artId)) return null;
      return art.get(artId) ?? null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (pollTimer) clearInterval(pollTimer);
      if (restartTimer) clearTimeout(restartTimer);
      pollTimer = null;
      restartTimer = null;
      stopWorker();
      listeners.clear();
    },
  };
}
