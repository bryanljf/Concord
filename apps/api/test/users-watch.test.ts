import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserStore } from '../src/auth';
import { watchUsersFile } from '../src/users-watch';
import { ALICE, BOB, fakeLogger, waitFor } from './helpers';

describe('watchUsersFile', () => {
  it('reloads on change and keeps the previous users when the file is invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telao-users-'));
    const path = join(dir, 'users.json');
    await writeFile(path, JSON.stringify({ users: [ALICE] }));
    const store = await UserStore.fromFile(path);
    const log = fakeLogger();
    const watcher = watchUsersFile({ path, store, log, debounceMs: 50 });
    try {
      await writeFile(path, JSON.stringify({ users: [ALICE, BOB] }));
      await waitFor(() => store.findById('bob') !== undefined);
      expect(log.info).toHaveBeenCalledWith({ path, users: 2 }, expect.any(String));

      const errorsBefore = log.error.mock.calls.length;
      await writeFile(path, '{ "users": [ oops');
      await waitFor(() => log.error.mock.calls.length > errorsBefore);
      expect(store.size).toBe(2);
      expect(store.findByKey(BOB.key)).toEqual(BOB);
    } finally {
      watcher.stop();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
