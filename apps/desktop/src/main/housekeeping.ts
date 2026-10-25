/**
 * Start-up housekeeping: Concord must not leave storage behind on anyone's PC. Each routine runs
 * once after `ready`, in the background; any failure is only logged. Electron-free: `index.ts`
 * passes the paths.
 *
 * - electron-updater's cache (`%LOCALAPPDATA%\<updaterCacheDirName>`): an update that is already
 *   installed (`pending\`, ~120 MB) and the copy of the installer kept for differential updates
 *   (`installer.exe`, ~120 MB, plus `current.blockmap`). A newer update waiting to be installed
 *   is never touched, and the updater's checks wait for this (`UpdaterDeps.whenReady`).
 * - `%APPDATA%\@telao`: data of the app's former name, which only ever ran in development.
 * - The Jam's yt-dlp (a task from `jam/index.ts`): the per-download temp folders an earlier
 *   session left, older onedir versions, and after 30 days without use the whole of it (the
 *   onedir folder, the single-file build and its record).
 */
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from './log';

const logger = log('housekeeping');

/** Chromium's HTTP cache cap (`--disk-cache-size`): covers and avatars need little. */
export const DISK_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** electron-builder names it `<lowercased package name>-updater`; anything else is not ours. */
const UPDATER_CACHE_DIR_PATTERN = /^[a-z0-9@._-]+-updater$/;

/** `artifactName` in electron-builder.yml is `Concord-Setup-${version}.${ext}`. */
const INSTALLER_VERSION_PATTERN = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.exe$/i;

/** `updaterCacheDirName` from electron-builder's `app-update.yml`, or null. */
export function parseUpdaterCacheDirName(yaml: string): string | null {
  const match = /^updaterCacheDirName:\s*(['"]?)([^'"\r\n]*)\1\s*$/m.exec(yaml);
  const name = match?.[2]?.trim();
  return name && UPDATER_CACHE_DIR_PATTERN.test(name) && !name.includes('..') ? name : null;
}

/** The version in an installer file name (`Concord-Setup-0.2.2.exe` → `0.2.2`), or null. */
export function installerVersion(fileName: string): string | null {
  return INSTALLER_VERSION_PATTERN.exec(fileName)?.[1] ?? null;
}

/** Semver order of `x.y.z[-pre]`: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const split = (version: string): [number[], string[]] => {
    const [core = '', pre] = version.split(/-(.*)/s);
    return [core.split('.').map(Number), pre ? pre.split('.') : []];
  };
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (coreA[i] ?? 0) - (coreB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A release ranks above its pre-releases.
  if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;
  for (let i = 0; i < Math.max(preA.length, preB.length); i += 1) {
    const x = preA[i];
    const y = preB[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

/** What `pending\update-info.json` says: the version waiting there, or why it is unknown. */
async function pendingVersion(pendingDir: string): Promise<string | 'unreadable' | 'unknown'> {
  let info: unknown;
  try {
    info = JSON.parse(await readFile(join(pendingDir, 'update-info.json'), 'utf8'));
  } catch {
    return 'unreadable';
  }
  const fileName =
    typeof info === 'object' && info !== null ? (info as { fileName?: unknown }).fileName : null;
  if (typeof fileName !== 'string' || fileName === '') return 'unreadable';
  if (!existsSync(join(pendingDir, fileName))) return 'unreadable';
  return installerVersion(fileName) ?? 'unknown';
}

async function removeEmptyDir(dir: string): Promise<void> {
  await rmdir(dir).catch(() => undefined);
}

export interface UpdaterCacheOptions {
  /** `process.resourcesPath` of the installed app; null in development (no app-update.yml). */
  resourcesPath: string | null;
  /** electron-updater's base cache path (`%LOCALAPPDATA%`). */
  localAppData: string;
  currentVersion: string;
}

/** Removes what electron-updater keeps at rest, except a newer update waiting to be installed. */
export async function cleanUpdaterCache(options: UpdaterCacheOptions): Promise<void> {
  if (options.resourcesPath === null) return;
  let yaml: string;
  try {
    yaml = await readFile(join(options.resourcesPath, 'app-update.yml'), 'utf8');
  } catch {
    logger.info('no app-update.yml; leaving the updater cache alone');
    return;
  }
  const dirName = parseUpdaterCacheDirName(yaml);
  if (dirName === null) {
    logger.warn('app-update.yml has no usable updaterCacheDirName');
    return;
  }
  const cacheDir = join(options.localAppData, dirName);
  if (!existsSync(cacheDir)) return;

  const pendingDir = join(cacheDir, 'pending');
  if (existsSync(pendingDir)) {
    const version = await pendingVersion(pendingDir);
    if (version === 'unknown') {
      // Never guess: deleting a real update would make it download again on every start.
      logger.warn('pending update with an unexpected file name; keeping the updater cache');
      return;
    }
    if (version !== 'unreadable' && compareVersions(version, options.currentVersion) > 0) {
      logger.info(`update ${version} is waiting to be installed; keeping the updater cache`);
      return;
    }
    await rm(pendingDir, { recursive: true, force: true });
    logger.info(
      `removed the installed update from the updater cache (${version === 'unreadable' ? 'incomplete' : version})`,
    );
  }
  for (const name of ['installer.exe', 'current.blockmap']) {
    const file = join(cacheDir, name);
    if (!existsSync(file)) continue;
    await rm(file, { force: true });
    logger.info(`removed ${name} from the updater cache`);
  }
  await removeEmptyDir(cacheDir);
}

/** Install folders the app could have had under its former name (it never shipped as Telão). */
const LEGACY_INSTALL_DIRS = ['@telaodesktop', 'telao-desktop', 'Telão', 'Telao'];

export interface LegacyDataOptions {
  /** `%APPDATA%` */
  appData: string;
  /** `%LOCALAPPDATA%` */
  localAppData: string;
}

/** Removes `%APPDATA%\@telao` unless a Telão installation still exists. */
export async function removeLegacyData(options: LegacyDataOptions): Promise<void> {
  const legacy = join(options.appData, '@telao');
  let info;
  try {
    info = await lstat(legacy);
  } catch {
    return;
  }
  // A real folder only: never follow a link somewhere else.
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  const programs = join(options.localAppData, 'Programs');
  const installed = LEGACY_INSTALL_DIRS.find((name) => existsSync(join(programs, name)));
  if (installed) {
    logger.info(`keeping ${legacy}: ${installed} is still installed`);
    return;
  }
  await rm(legacy, { recursive: true, force: true });
  logger.info(`removed ${legacy} (data of the app's former name)`);
}

/** Removes everything inside `dir` except `keep` (absolute paths), then `dir` itself if empty. */
export async function emptyDir(dir: string, keep: ReadonlySet<string> = new Set()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (keep.has(path)) continue;
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
  await removeEmptyDir(dir);
}

export interface HousekeepingTask {
  name: string;
  run(): Promise<unknown>;
}

/** Runs the tasks one after another; a failure is logged and the next task still runs. */
export async function runHousekeeping(tasks: readonly HousekeepingTask[]): Promise<void> {
  for (const task of tasks) {
    try {
      await task.run();
    } catch (err) {
      logger.warn(`${task.name} failed`, err);
    }
  }
}

/** The updater never waits longer than this for its cache cleanup. */
export const UPDATER_CACHE_CLEANUP_TIMEOUT_MS = 60_000;

export interface StartupHousekeepingOptions {
  platform: NodeJS.Platform;
  /** `process.resourcesPath` of the installed app; null in development. */
  resourcesPath: string | null;
  /** `%APPDATA%` */
  appData: string;
  /** `%LOCALAPPDATA%` */
  localAppData: string;
  currentVersion: string;
  /** Run after the built-in routines (the Jam's yt-dlp files). */
  tasks?: readonly HousekeepingTask[];
}

export interface StartupHousekeeping {
  /** Resolves once the updater cache is clean (or that gave up): `UpdaterDeps.whenReady`. */
  updaterCacheCleaned: Promise<void>;
  done: Promise<void>;
}

/** Starts every routine in the background; nothing here ever rejects. */
export function startHousekeeping(options: StartupHousekeepingOptions): StartupHousekeeping {
  const windows = options.platform === 'win32';
  const updaterCache = runHousekeeping(
    windows ? [{ name: 'updater cache cleanup', run: () => cleanUpdaterCache(options) }] : [],
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      logger.warn('updater cache cleanup is taking too long; letting the updater run');
      resolve();
    }, UPDATER_CACHE_CLEANUP_TIMEOUT_MS);
    timer.unref?.();
  });
  const updaterCacheCleaned = Promise.race([updaterCache, timeout]).finally(() =>
    clearTimeout(timer),
  );
  const done = updaterCache.then(() =>
    runHousekeeping([
      ...(windows ? [{ name: 'legacy data cleanup', run: () => removeLegacyData(options) }] : []),
      ...(options.tasks ?? []),
    ]),
  );
  return { updaterCacheCleaned, done };
}
