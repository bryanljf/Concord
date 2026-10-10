import { globalShortcut } from 'electron';
import { log } from './log';
import type { SettingsStore } from './settings';

const logger = log('shortcuts');

/**
 * Registers the global "transmitir" shortcut from settings and follows changes to it. A failed
 * registration (invalid accelerator or taken by another app) is logged and otherwise ignored.
 */
export function bindGlobalShortcut(settings: SettingsStore, onTrigger: () => void): () => void {
  let current: string | null = null;

  function register(accelerator: string): void {
    if (current) {
      globalShortcut.unregister(current);
      current = null;
    }
    const trimmed = accelerator.trim();
    if (trimmed === '') {
      logger.info('no shortcut configured');
      return;
    }
    try {
      if (globalShortcut.register(trimmed, onTrigger)) {
        current = trimmed;
        logger.info(`registered ${trimmed}`);
      } else {
        logger.warn(`could not register ${trimmed} (already in use?)`);
      }
    } catch (err) {
      logger.warn(`invalid shortcut ${trimmed}`, err);
    }
  }

  register(settings.get().shortcut);
  const unsubscribe = settings.onChange((next, previous) => {
    if (next.shortcut !== previous.shortcut) register(next.shortcut);
  });
  return () => {
    unsubscribe();
    if (current) globalShortcut.unregister(current);
    current = null;
  };
}
