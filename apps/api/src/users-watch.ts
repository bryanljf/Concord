import { watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { UserStore } from './auth';
import type { Logger } from './logger';

export interface UsersWatchOptions {
  /** Absolute path to users.json. */
  path: string;
  store: UserStore;
  log: Logger;
  debounceMs?: number;
}

export interface UsersWatcher {
  stop(): void;
}

/**
 * Reloads the user store whenever users.json changes (e.g. after `user:add`). Watches the
 * directory rather than the file so editors that replace the file atomically are caught too.
 * A file that fails to parse is logged and the previous users are kept.
 */
export function watchUsersFile(options: UsersWatchOptions): UsersWatcher {
  const { path, store, log, debounceMs = 500 } = options;
  const fileName = basename(path).toLowerCase();
  let timer: NodeJS.Timeout | undefined;

  async function reload(): Promise<void> {
    timer = undefined;
    try {
      await store.reloadFromFile(path);
      log.info({ path, users: store.size }, 'users file reloaded');
    } catch (err) {
      log.error({ err, path }, 'users file reload failed, keeping previous users');
    }
  }

  const watcher = watch(dirname(path), { persistent: false }, (_eventType, changed) => {
    if (changed && changed.toLowerCase() !== fileName) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(reload, debounceMs);
  });
  watcher.on('error', (err) => log.error({ err, path }, 'users file watcher error'));

  return {
    stop(): void {
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
