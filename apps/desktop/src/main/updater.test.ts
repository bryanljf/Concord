import { afterEach, describe, expect, it, vi } from 'vitest';

// electron-updater requires `electron` at load time; the real `autoUpdater` is never used here.
vi.mock('electron-updater', () => ({ autoUpdater: {} }));

import type { UpdateStatus } from '../preload/api';
import {
  createUpdater,
  DEV_UNSUPPORTED_REASON,
  NOTHING_TO_INSTALL_MESSAGE,
  reduceUpdateStatus,
  UPDATE_ERROR_PREFIX,
  updateErrorMessage,
  type AppUpdaterLike,
} from './updater';
import { UserFacingError } from './validation';

describe('reduceUpdateStatus', () => {
  const idle: UpdateStatus = { state: 'idle' };

  it('follows the electron-updater lifecycle', () => {
    const checking = reduceUpdateStatus(idle, { type: 'checking' }, '0.1.0');
    expect(checking).toEqual({ state: 'checking' });
    const available = reduceUpdateStatus(
      checking,
      { type: 'available', version: '0.2.0' },
      '0.1.0',
    );
    expect(available).toEqual({ state: 'available', version: '0.2.0' });
    const downloading = reduceUpdateStatus(available, { type: 'progress', percent: 42.4 }, '0.1.0');
    expect(downloading).toEqual({ state: 'downloading', version: '0.2.0', percent: 42 });
    expect(
      reduceUpdateStatus(downloading, { type: 'downloaded', version: '0.2.0' }, '0.1.0'),
    ).toEqual({
      state: 'ready',
      version: '0.2.0',
    });
  });

  it('reports the current version when up to date', () => {
    expect(reduceUpdateStatus(idle, { type: 'not-available' }, '0.1.0')).toEqual({
      state: 'up_to_date',
      version: '0.1.0',
    });
  });

  it('clamps progress and copes with a missing version', () => {
    expect(reduceUpdateStatus(idle, { type: 'progress', percent: 140 }, '0.1.0')).toEqual({
      state: 'downloading',
      version: '?',
      percent: 100,
    });
    expect(reduceUpdateStatus(idle, { type: 'progress', percent: -3 }, '0.1.0')).toMatchObject({
      percent: 0,
    });
  });

  it('maps errors', () => {
    expect(reduceUpdateStatus(idle, { type: 'error', message: 'x' }, '0.1.0')).toEqual({
      state: 'error',
      message: 'x',
    });
  });
});

describe('updateErrorMessage', () => {
  it('recognises offline and 404 failures', () => {
    expect(updateErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(
      `${UPDATE_ERROR_PREFIX}: sem conexão com a internet.`,
    );
    expect(updateErrorMessage(new Error('getaddrinfo ENOTFOUND github.com'))).toBe(
      `${UPDATE_ERROR_PREFIX}: sem conexão com a internet.`,
    );
    expect(
      updateErrorMessage(
        new Error('Cannot find latest.yml in the latest release artifacts: HttpError: 404'),
      ),
    ).toBe(`${UPDATE_ERROR_PREFIX}: nenhuma versão publicada foi encontrada.`);
  });

  it('keeps a shortened reason otherwise', () => {
    expect(updateErrorMessage(new Error('  weird   failure '))).toBe(
      `${UPDATE_ERROR_PREFIX}: weird failure`,
    );
    expect(updateErrorMessage('')).toBe(`${UPDATE_ERROR_PREFIX}.`);
    const long = updateErrorMessage(new Error('a'.repeat(500)));
    expect(long.length).toBeLessThan(UPDATE_ERROR_PREFIX.length + 170);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

function makeAutoUpdater() {
  const listeners = new Map<string, Listener>();
  const raw = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null as unknown,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return raw;
    }),
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
  };
  return {
    raw,
    fake: raw as unknown as AppUpdaterLike,
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  };
}

function makePackaged(
  overrides: { initialDelayMs?: number; intervalMs?: number; whenReady?: Promise<unknown> } = {},
) {
  const auto = makeAutoUpdater();
  const onBeforeInstall = vi.fn();
  const updater = createUpdater({
    isPackaged: true,
    currentVersion: '0.1.0',
    onBeforeInstall,
    autoUpdater: auto.fake,
    ...overrides,
  });
  return { ...auto, updater, onBeforeInstall };
}

describe('createUpdater (development build)', () => {
  it('reports unsupported and refuses to install', async () => {
    const updater = createUpdater({
      isPackaged: false,
      currentVersion: '0.1.0',
      onBeforeInstall: vi.fn(),
    });
    const unsupported = { state: 'unsupported', reason: DEV_UNSUPPORTED_REASON };
    expect(updater.getStatus()).toEqual(unsupported);
    expect(await updater.check()).toEqual(unsupported);
    expect(() => updater.install()).toThrow(UserFacingError);
    expect(() => updater.install()).toThrow(DEV_UNSUPPORTED_REASON);
    updater.start();
    updater.stop();
  });
});

describe('createUpdater (packaged)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('configures electron-updater for background downloads and logging', () => {
    const { raw, updater } = makePackaged();
    expect(raw.autoDownload).toBe(true);
    expect(raw.autoInstallOnAppQuit).toBe(true);
    // No previous installer is kept on disk to diff against.
    expect((raw as { disableDifferentialDownload?: boolean }).disableDifferentialDownload).toBe(
      true,
    );
    expect(raw.logger).not.toBeNull();
    expect(updater.getStatus()).toEqual({ state: 'idle' });
    expect(raw.on.mock.calls[0]?.[0]).toBe('error');
  });

  it('maps events to statuses and notifies listeners once per change', () => {
    const { emit, updater } = makePackaged();
    const seen: UpdateStatus[] = [];
    updater.onStatus((status) => seen.push(status));

    emit('checking-for-update');
    emit('checking-for-update');
    emit('update-available', { version: '0.2.0' });
    emit('download-progress', { percent: 10 });
    emit('download-progress', { percent: 10.2 });
    emit('update-downloaded', { version: '0.2.0' });

    expect(seen).toEqual([
      { state: 'checking' },
      { state: 'available', version: '0.2.0' },
      { state: 'downloading', version: '0.2.0', percent: 10 },
      { state: 'ready', version: '0.2.0' },
    ]);
    expect(updater.getStatus()).toEqual({ state: 'ready', version: '0.2.0' });
  });

  it('check() resolves with the status the check led to', async () => {
    const { raw, emit, updater } = makePackaged();
    raw.checkForUpdates.mockImplementation(async () => {
      emit('checking-for-update');
      emit('update-not-available', { version: '0.1.0' });
      return null;
    });
    expect(await updater.check()).toEqual({ state: 'up_to_date', version: '0.1.0' });
  });

  it('check() waits for the start-up cleanup of the updater cache', async () => {
    let finishCleanup!: () => void;
    const whenReady = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    const { raw, updater } = makePackaged({ whenReady });
    const checked = updater.check();
    await new Promise((resolve) => setImmediate(resolve));
    expect(raw.checkForUpdates).not.toHaveBeenCalled();
    finishCleanup();
    await checked;
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(1);

    // A cleanup that failed anyway must not keep the updater from working.
    const failed = makePackaged({ whenReady: Promise.reject(new Error('boom')) });
    await failed.updater.check();
    expect(failed.raw.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('check() turns a rejection into an error status instead of throwing', async () => {
    const { raw, updater } = makePackaged();
    raw.checkForUpdates.mockRejectedValue(new Error('HttpError: 404 Not Found'));
    expect(await updater.check()).toEqual({
      state: 'error',
      message: `${UPDATE_ERROR_PREFIX}: nenhuma versão publicada foi encontrada.`,
    });
  });

  it('install() only works with a downloaded update and flags the quit first', () => {
    const { raw, emit, updater, onBeforeInstall } = makePackaged();
    expect(() => updater.install()).toThrow(NOTHING_TO_INSTALL_MESSAGE);
    expect(raw.quitAndInstall).not.toHaveBeenCalled();

    emit('update-downloaded', { version: '0.2.0' });
    updater.install();
    expect(onBeforeInstall).toHaveBeenCalledTimes(1);
    expect(raw.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(onBeforeInstall.mock.invocationCallOrder[0]).toBeLessThan(
      raw.quitAndInstall.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('start() checks after the initial delay and then periodically; stop() cancels', () => {
    vi.useFakeTimers();
    const { raw, updater } = makePackaged({ initialDelayMs: 100, intervalMs: 1_000 });
    updater.start();
    updater.start();
    expect(raw.checkForUpdates).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(2);
    updater.stop();
    vi.advanceTimersByTime(5_000);
    expect(raw.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
