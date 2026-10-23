import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// electron-updater requires `electron` at load time; the real `autoUpdater` is never used here.
vi.mock('electron-updater', () => ({ autoUpdater: {} }));

import type { UpdateStatus } from '../preload/api';
import { createFakeAutoUpdater, DOWNLOAD_STEP_MS, FAKE_CHECK_MS } from './fake-updater';
import { createUpdater } from './updater';

describe('createFakeAutoUpdater', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('drives the real updater through checking, downloading and ready', async () => {
    const relaunch = vi.fn();
    const updater = createUpdater({
      isPackaged: true,
      currentVersion: '0.2.1',
      onBeforeInstall: () => undefined,
      autoUpdater: createFakeAutoUpdater('0.2.2', relaunch),
    });
    const seen: UpdateStatus['state'][] = [];
    updater.onStatus((status) => seen.push(status.state));

    await updater.check();
    expect(updater.getStatus()).toEqual({ state: 'checking' });
    await vi.advanceTimersByTimeAsync(FAKE_CHECK_MS + DOWNLOAD_STEP_MS * 20);

    expect(updater.getStatus()).toEqual({ state: 'ready', version: '0.2.2' });
    expect(seen).toEqual(expect.arrayContaining(['checking', 'available', 'downloading', 'ready']));

    updater.install();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it('ignores a check while one is running', async () => {
    const fake = createFakeAutoUpdater('0.2.2', () => undefined);
    const checking = vi.fn();
    fake.on('checking-for-update', checking);
    await fake.checkForUpdates();
    await fake.checkForUpdates();
    expect(checking).toHaveBeenCalledOnce();
  });
});
