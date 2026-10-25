import { EventEmitter } from 'node:events';
import { log } from './log';
import type { AppUpdaterLike } from './updater';

const logger = log('fake-updater');

/** Simulated timings: the check, then +`DOWNLOAD_STEP_PERCENT` every `DOWNLOAD_STEP_MS`. */
export const FAKE_CHECK_MS = 1500;
export const DOWNLOAD_STEP_MS = 400;
export const DOWNLOAD_STEP_PERCENT = 6;

/**
 * Dev only (`--fake-update=<version>`): an electron-updater stand-in that finds `version` on each
 * check and "downloads" it in a few seconds, so the update UI (sidebar arrow, banner, Sobre) can be
 * tried without publishing a release. Installing relaunches the app instead.
 */
export function createFakeAutoUpdater(version: string, relaunch: () => void): AppUpdaterLike {
  const events = new EventEmitter();
  let running = false;

  function download(): void {
    events.emit('update-available', { version });
    let percent = 0;
    const timer = setInterval(() => {
      percent = Math.min(100, percent + DOWNLOAD_STEP_PERCENT);
      events.emit('download-progress', { percent });
      if (percent < 100) return;
      clearInterval(timer);
      running = false;
      events.emit('update-downloaded', { version });
    }, DOWNLOAD_STEP_MS);
  }

  const fake = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableDifferentialDownload: false,
    logger: null as unknown,
    on(event: string, listener: (...args: unknown[]) => void) {
      events.on(event, listener);
      return fake;
    },
    checkForUpdates() {
      if (!running) {
        running = true;
        events.emit('checking-for-update');
        setTimeout(download, FAKE_CHECK_MS);
      }
      return Promise.resolve(null);
    },
    quitAndInstall() {
      logger.info(`simulated install of ${version}: relaunching`);
      relaunch();
    },
  };
  return fake as unknown as AppUpdaterLike;
}
