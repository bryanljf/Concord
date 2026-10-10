import { app } from 'electron';
import { log } from './log';
import type { SettingsStore } from './settings';

const logger = log('autostart');

/** Registers (or removes) the app as a login item; the `--hidden` flag keeps the window closed. */
export function applyAutostart(enabled: boolean): void {
  if (!app.isPackaged) {
    logger.info(`dev build: would set openAtLogin=${enabled} with args ["--hidden"]`);
    return;
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
    logger.info(`openAtLogin=${enabled}`);
  } catch (err) {
    logger.warn('could not update login item settings', err);
  }
}

/** Applies the current setting now and again whenever `launchAtLogin` changes. */
export function bindAutostart(settings: SettingsStore): () => void {
  applyAutostart(settings.get().launchAtLogin);
  return settings.onChange((next, previous) => {
    if (next.launchAtLogin !== previous.launchAtLogin) applyAutostart(next.launchAtLogin);
  });
}
