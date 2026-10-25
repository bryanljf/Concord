import { autoUpdater as electronAutoUpdater, type AppUpdater } from 'electron-updater';
import type { UpdateStatus } from '../preload/api';
import { log } from './log';
import { UserFacingError } from './validation';

const logger = log('updater');

/** First check shortly after start-up, then periodically. */
export const UPDATE_INITIAL_DELAY_MS = 10_000;
export const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

export const DEV_UNSUPPORTED_REASON =
  'Atualizações automáticas só funcionam na versão instalada do Concord.';
export const NOTHING_TO_INSTALL_MESSAGE = 'Nenhuma atualização pronta para instalar.';
export const UPDATE_ERROR_PREFIX = 'Não foi possível verificar atualizações';

// ---------------------------------------------------------------------------
// Status mapping (pure)
// ---------------------------------------------------------------------------

/** electron-updater events reduced to what the status machine needs. */
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; message: string };

function versionOf(status: UpdateStatus): string | null {
  return 'version' in status ? status.version : null;
}

export function reduceUpdateStatus(
  previous: UpdateStatus,
  event: UpdaterEvent,
  currentVersion: string,
): UpdateStatus {
  switch (event.type) {
    case 'checking':
      return { state: 'checking' };
    case 'available':
      return { state: 'available', version: event.version };
    case 'not-available':
      return { state: 'up_to_date', version: currentVersion };
    case 'progress': {
      const percent = Math.min(100, Math.max(0, Math.round(event.percent)));
      return { state: 'downloading', version: versionOf(previous) ?? '?', percent };
    }
    case 'downloaded':
      return { state: 'ready', version: event.version };
    case 'error':
      return { state: 'error', message: event.message };
  }
}

const OFFLINE_PATTERN =
  /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_NETWORK_CHANGED|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;
const MAX_DETAIL_LENGTH = 160;

/** pt-BR message for an updater failure; the raw reason is kept (shortened) for diagnosis. */
export function updateErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (OFFLINE_PATTERN.test(text)) return `${UPDATE_ERROR_PREFIX}: sem conexão com a internet.`;
  if (/\b404\b/.test(text)) {
    return `${UPDATE_ERROR_PREFIX}: nenhuma versão publicada foi encontrada.`;
  }
  if (text === '') return `${UPDATE_ERROR_PREFIX}.`;
  const detail =
    text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text;
  return `${UPDATE_ERROR_PREFIX}: ${detail}`;
}

export function isSameUpdateStatus(a: UpdateStatus, b: UpdateStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Updater
// ---------------------------------------------------------------------------

/** The slice of electron-updater's `autoUpdater` we use (injectable in tests). */
export type AppUpdaterLike = Pick<
  AppUpdater,
  | 'autoDownload'
  | 'autoInstallOnAppQuit'
  | 'disableDifferentialDownload'
  | 'logger'
  | 'on'
  | 'checkForUpdates'
  | 'quitAndInstall'
>;

export interface UpdaterDeps {
  /** electron-updater only works with the installed app (`app-update.yml` next to the asar). */
  isPackaged: boolean;
  currentVersion: string;
  /** Called right before `quitAndInstall`, so close-to-tray lets the windows close. */
  onBeforeInstall(): void;
  autoUpdater?: AppUpdaterLike;
  /**
   * Every check waits for it: the start-up cleanup of electron-updater's cache
   * (`housekeeping.ts`) must never race a download. Must not reject.
   */
  whenReady?: Promise<unknown>;
  initialDelayMs?: number;
  intervalMs?: number;
}

export type UpdateStatusListener = (status: UpdateStatus) => void;

export interface Updater {
  getStatus(): UpdateStatus;
  /** Runs a check now and resolves with the status it led to. */
  check(): Promise<UpdateStatus>;
  /** Quits and installs a `ready` update; throws a user-facing error otherwise. */
  install(): void;
  onStatus(listener: UpdateStatusListener): () => void;
  /** Schedules the start-up check and the periodic ones. */
  start(): void;
  stop(): void;
}

export function createUpdater(deps: UpdaterDeps): Updater {
  const listeners = new Set<UpdateStatusListener>();
  let status: UpdateStatus = deps.isPackaged
    ? { state: 'idle' }
    : { state: 'unsupported', reason: DEV_UNSUPPORTED_REASON };
  let initialTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;

  function setStatus(next: UpdateStatus): void {
    if (isSameUpdateStatus(status, next)) return;
    status = next;
    logger.info(`status → ${JSON.stringify(next)}`);
    for (const listener of listeners) listener(next);
  }

  function apply(event: UpdaterEvent): void {
    setStatus(reduceUpdateStatus(status, event, deps.currentVersion));
  }

  function onStatus(listener: UpdateStatusListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  if (!deps.isPackaged) {
    logger.info('development build: automatic updates disabled');
    return {
      getStatus: () => status,
      check: async () => status,
      install() {
        throw new UserFacingError(DEV_UNSUPPORTED_REASON);
      },
      onStatus,
      start: () => undefined,
      stop: () => undefined,
    };
  }

  const updater = deps.autoUpdater ?? electronAutoUpdater;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  // Always the full installer: a differential download needs the previous installer kept in
  // %LOCALAPPDATA% (~120 MB at rest), which the start-up housekeeping deletes.
  updater.disableDifferentialDownload = true;
  updater.logger = {
    info: (message?: unknown) => logger.info(String(message)),
    warn: (message?: unknown) => logger.warn(String(message)),
    error: (message?: unknown) => logger.error(String(message)),
    debug: (message: string) => logger.info(message),
  };
  // Attached first: an `error` event without a listener would throw inside electron-updater.
  updater.on('error', (err) => apply({ type: 'error', message: updateErrorMessage(err) }));
  updater.on('checking-for-update', () => apply({ type: 'checking' }));
  updater.on('update-available', (info) => apply({ type: 'available', version: info.version }));
  updater.on('update-not-available', () => apply({ type: 'not-available' }));
  updater.on('download-progress', (progress) =>
    apply({ type: 'progress', percent: progress.percent }),
  );
  updater.on('update-downloaded', (info) => apply({ type: 'downloaded', version: info.version }));

  async function check(): Promise<UpdateStatus> {
    if (deps.whenReady) await deps.whenReady.catch(() => undefined);
    try {
      await updater.checkForUpdates();
    } catch (err) {
      // electron-updater also emits `error`; this covers rejections without one.
      apply({ type: 'error', message: updateErrorMessage(err) });
    }
    return status;
  }

  function scheduledCheck(): void {
    logger.info('scheduled update check');
    void check();
  }

  return {
    getStatus: () => status,
    check,
    install() {
      if (status.state !== 'ready') throw new UserFacingError(NOTHING_TO_INSTALL_MESSAGE);
      logger.info(`installing ${status.version}; quitting`);
      deps.onBeforeInstall();
      // Silent install, then relaunch into the new version.
      updater.quitAndInstall(true, true);
    },
    onStatus,
    start() {
      if (initialTimer || intervalTimer) return;
      const initialDelayMs = deps.initialDelayMs ?? UPDATE_INITIAL_DELAY_MS;
      const intervalMs = deps.intervalMs ?? UPDATE_INTERVAL_MS;
      initialTimer = setTimeout(scheduledCheck, initialDelayMs);
      intervalTimer = setInterval(scheduledCheck, intervalMs);
      initialTimer.unref();
      intervalTimer.unref();
      logger.info(
        `scheduled: first check in ${Math.round(initialDelayMs / 1000)} s, then every ${Math.round(intervalMs / 60_000)} min`,
      );
    },
    stop() {
      if (initialTimer) clearTimeout(initialTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      initialTimer = null;
      intervalTimer = null;
    },
  };
}
