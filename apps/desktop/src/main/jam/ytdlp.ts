/**
 * The yt-dlp the Jam downloads songs with, fetched from the official GitHub release on first use
 * and only ever run after it matched the release's `SHA2-256SUMS`:
 * - preferably the "onedir" build (`yt-dlp_win.zip`): it starts in ~0.26 s, where the single-file
 *   build spends ~0.6 s unpacking itself into TEMP on every run (and ~0.35 s deleting it at exit).
 *   The zip is verified before anything is extracted from it (with Windows' own tar.exe), into a
 *   folder per version, `userData/bin/yt-dlp/<version>/`: a running yt-dlp locks its files, so a
 *   version is never replaced in place. The record switches to the new folder once it ran
 *   `--version` (the antivirus scans the new files then, not during the first song); older
 *   folders are deleted once no yt-dlp runs.
 * - otherwise (no zip in the release, or it would not extract or run) the single-file
 *   `userData/bin/yt-dlp.exe`.
 * `yt-dlp.json` records what was installed. Checked for updates at most once a day (before a
 * download, or at the warm-up), plus a forced check when a download fails like an outdated
 * extractor does. Every check and install runs one at a time. Everything is deleted at start-up
 * after 30 days without use (`removeIfUnused`). Electron-free: `index.ts` passes the folder.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '../log';
import { UserFacingError } from '../validation';
import { runYtDlpVersion } from './download';

const logger = log('yt-dlp');

/** The single-file build, and the executable's name in the onedir one. */
export const YTDLP_FILE_NAME = 'yt-dlp.exe';
/** The onedir build's release asset, and the folder holding its versions. */
export const YTDLP_ONEDIR_ASSET = 'yt-dlp_win.zip';
export const YTDLP_ONEDIR_DIR_NAME = 'yt-dlp';
const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
export const YTDLP_BINARY_URL = `${RELEASE_URL}/${YTDLP_FILE_NAME}`;
export const YTDLP_ONEDIR_URL = `${RELEASE_URL}/${YTDLP_ONEDIR_ASSET}`;
export const YTDLP_SUMS_URL = `${RELEASE_URL}/SHA2-256SUMS`;
/** What was verified and when it was last compared with the release (next to the binary). */
export const YTDLP_META_FILE_NAME = 'yt-dlp.json';
/** Every PyInstaller onedir build has it: a folder without it is not one (or is broken). */
const ONEDIR_MARKER = ['_internal', 'base_library.zip'] as const;
/** A version folder: the zip's hash prefix and a random suffix (`3f2a…-9c1d…`). */
const ONEDIR_VERSION_PATTERN = /^[0-9a-f]{12}-[0-9a-f]{8}$/;

/** Regular update check. */
export const YTDLP_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Forced checks (a download failed like an outdated extractor) are not repeated sooner. */
export const YTDLP_FORCED_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** After a check failed (offline, GitHub down) the verified copy is used this long before retrying. */
export const YTDLP_RETRY_CHECK_MS = 60 * 60 * 1000;
/** Unused this long, yt-dlp (either build) is deleted at start-up. */
export const YTDLP_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;
/** Use is written to the record at most this often. */
const USE_RECORD_INTERVAL_MS = 60 * 60 * 1000;
/** The release assets are ~18 MB; anything this big is not them. */
export const YTDLP_MAX_BYTES = 100 * 1024 * 1024;
const SUMS_MAX_BYTES = 256 * 1024;
const SUMS_TIMEOUT_MS = 20_000;
const BINARY_TIMEOUT_MS = 5 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 2 * 60 * 1000;

export const YTDLP_FETCH_FAILED_MESSAGE =
  'Não foi possível baixar o yt-dlp (o programa que baixa as músicas do YouTube). Verifique sua conexão e tente de novo.';
export const YTDLP_CHECKSUM_MESSAGE =
  'O yt-dlp baixado não passou na verificação de segurança e foi descartado. Tente de novo mais tarde.';
export const YTDLP_NO_SPACE_MESSAGE =
  'Sem espaço em disco para instalar o yt-dlp. Libere espaço e tente de novo.';

/** A failure to fetch or verify yt-dlp; `message` is pt-BR and safe to show. */
export class YtDlpError extends UserFacingError {
  override readonly name = 'YtDlpError';
}

/** The onedir zip would not extract into a build that runs: use the single-file one. */
class ExtractError extends Error {
  override readonly name = 'ExtractError';
}

export type YtDlpBuild = 'onedir' | 'onefile';

export interface YtDlpBinary {
  path: string;
  /** Bumped by every install in this process: tells whether a forced check changed anything. */
  revision: number;
}

export interface EnsureOptions {
  /** Compare with the release now, even within the daily interval. */
  force?: boolean;
  /** Called when the binary starts being downloaded while this call waits for it. */
  onPreparing?: () => void;
}

export interface YtDlpManager {
  /** Best guess, without waiting, that `ensure()` will have to download the binary first. */
  needsInstall(): boolean;
  /** Resolves with a verified binary, fetching or updating it when due; rejects with `YtDlpError`. */
  ensure(options?: EnsureOptions): Promise<YtDlpBinary>;
  /**
   * The warm-up's check: the verified binary, updated when due like `ensure()`, but without
   * counting as a use; null (and nothing fetched) when none is installed or it is about to be
   * deleted for lack of use. Never rejects.
   */
  warmUp(): Promise<YtDlpBinary | null>;
  /**
   * Deletes both builds and the record when the Jam has not needed yt-dlp for `idleMs` (it is
   * fetched again on demand); otherwise only deletes older onedir versions. Resolves with
   * whether a binary was deleted.
   */
  removeIfUnused(idleMs?: number): Promise<boolean>;
  /** Aborts a fetch in flight (quit). */
  destroy(): void;
}

export interface YtDlpManagerDeps {
  /** Folder of the binaries (`userData/bin`). */
  binDir: string;
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Prefer the onedir build (default: on Windows, the only platform it is published for). */
  onedir?: boolean;
  /** Extracts `zipPath` into the existing, empty `destDir` (default: Windows' tar.exe). */
  extractZip?: (zipPath: string, destDir: string) => Promise<void>;
  /** Runs `<exePath> --version`; null when it did not work (default: `runYtDlpVersion`). */
  runVersion?: (exePath: string) => Promise<string | null>;
  /** No yt-dlp runs now: older onedir versions are only deleted then (default: always idle). */
  isIdle?: () => boolean;
}

interface Installed {
  build: YtDlpBuild;
  /** The onedir version's folder under `yt-dlp/`. */
  dir?: string;
  /** SHA-256 of the release asset (the zip or yt-dlp.exe), as SHA2-256SUMS lists it. */
  sha256: string;
  /** SHA-256 of the yt-dlp.exe that runs (the asset itself for the single-file build). */
  exeSha256: string;
  /** A zip that would not extract or run: onedir is not tried again before the next release. */
  onedirFailed?: string;
}

interface Meta extends Installed {
  checkedAt: number;
  /** Last time the Jam needed yt-dlp (missing in records older than this field). */
  usedAt?: number;
}

/** What the release lists (null: not in SHA2-256SUMS). */
interface ReleaseSums {
  onefile: string | null;
  onedir: string | null;
}

interface Wanted {
  build: YtDlpBuild;
  sha256: string;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

/** The hash of `fileName` in a `sha256sum`-style listing (`<hex>  <name>` or `<hex> *<name>`). */
export function parseSha256Sums(text: string, fileName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (match?.[2] === fileName && match[1]) return match[1].toLowerCase();
  }
  return null;
}

function parseMeta(text: string): Meta | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { sha256, checkedAt, usedAt, onedirFailed, dir } = record;
  if (!isSha256(sha256)) return null;
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return null;
  // Records from before the onedir build describe the single-file one.
  const build = record.build ?? 'onefile';
  if (build !== 'onedir' && build !== 'onefile') return null;
  const exeSha256 = record.exeSha256 ?? (build === 'onefile' ? sha256 : undefined);
  if (!isSha256(exeSha256)) return null;
  const meta: Meta = { build, sha256, exeSha256, checkedAt };
  if (build === 'onedir') {
    // Never a path of its own: only a version folder name.
    if (typeof dir !== 'string' || !ONEDIR_VERSION_PATTERN.test(dir)) return null;
    meta.dir = dir;
  }
  if (typeof usedAt === 'number' && Number.isFinite(usedAt)) meta.usedAt = usedAt;
  if (isSha256(onedirFailed)) meta.onedirFailed = onedirFailed;
  return meta;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** Windows refuses to touch a file or folder in use with these. */
function isBusy(err: unknown): boolean {
  const code = errorCode(err);
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** The whole body, refusing anything larger than `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) throw new Error('empty body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Unpacks a zip with Windows' own bsdtar (Windows 10 1803 and later), which refuses absolute
 * paths and `..` in entry names by default.
 */
export function extractZipWithTar(zipPath: string, destDir: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const tar = join(systemRoot, 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(
      tar,
      ['-xf', zipPath, '-C', destDir],
      { windowsHide: true, timeout: EXTRACT_TIMEOUT_MS },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

export function createYtDlpManager(deps: YtDlpManagerDeps): YtDlpManager {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const preferOnedir = deps.onedir ?? process.platform === 'win32';
  const extractZip = deps.extractZip ?? extractZipWithTar;
  const runVersion = deps.runVersion ?? ((exePath: string) => runYtDlpVersion(exePath));
  const isIdle = deps.isIdle ?? (() => true);
  const { binDir } = deps;
  const onefileExe = join(binDir, YTDLP_FILE_NAME);
  const onedirRoot = join(binDir, YTDLP_ONEDIR_DIR_NAME);
  const metaPath = join(binDir, YTDLP_META_FILE_NAME);
  const lifetime = new AbortController();

  /** Calls run one after another on this chain. */
  let chain: Promise<unknown> = Promise.resolve();
  let revision = 0;
  let installing = false;
  /** `onPreparing` of the calls waiting on the chain. */
  const waiting = new Set<() => void>();
  /** Hashes of the executables on disk, kept while their size and mtime stay the same. */
  const hashes = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  let lastForcedCheckAt = Number.NEGATIVE_INFINITY;
  let lastUseRecordedAt = Number.NEGATIVE_INFINITY;
  let lastFailedCheckAt = Number.NEGATIVE_INFINITY;

  function exeOf(installed: Installed): string {
    return installed.build === 'onedir' && installed.dir !== undefined
      ? join(onedirRoot, installed.dir, YTDLP_FILE_NAME)
      : onefileExe;
  }

  function binary(installed: Installed): YtDlpBinary {
    return { path: exeOf(installed), revision };
  }

  async function localHash(path: string): Promise<string | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      hashes.delete(path);
      return null;
    }
    if (!info.isFile()) return null;
    const known = hashes.get(path);
    if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.sha256;
    const sha256 = await hashFile(path);
    hashes.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
    return sha256;
  }

  async function remember(path: string, sha256: string): Promise<void> {
    const info = await stat(path);
    hashes.set(path, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
  }

  /** The very build a previous check verified against the release is on disk, unchanged. */
  async function isTrusted(meta: Meta): Promise<boolean> {
    if (meta.build === 'onedir') {
      if (meta.dir === undefined) return false;
      if (!existsSync(join(onedirRoot, meta.dir, ...ONEDIR_MARKER))) return false;
    }
    return (await localHash(exeOf(meta))) === meta.exeSha256;
  }

  async function readMeta(): Promise<Meta | null> {
    try {
      return parseMeta(await readFile(metaPath, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeMeta(meta: Meta): Promise<void> {
    const tmp = `${metaPath}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(meta), 'utf8');
    await rename(tmp, metaPath);
  }

  // --- Fetching and installing ---------------------------------------------------------------

  async function fetchCapped(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
    const res = await fetchImpl(url, {
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), lifetime.signal]),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`${url.slice(url.lastIndexOf('/') + 1)} answered ${res.status}`);
    }
    return readCapped(res, maxBytes);
  }

  async function fetchSums(): Promise<ReleaseSums> {
    const sums = await fetchCapped(YTDLP_SUMS_URL, SUMS_TIMEOUT_MS, SUMS_MAX_BYTES);
    const text = sums.toString('utf8');
    return {
      onefile: parseSha256Sums(text, YTDLP_FILE_NAME),
      onedir: preferOnedir ? parseSha256Sums(text, YTDLP_ONEDIR_ASSET) : null,
    };
  }

  /** The build to have: onedir when the release has it (and this zip did not fail before). */
  function wanted(sums: ReleaseSums, meta: Meta | null): Wanted {
    const { onedir, onefile } = sums;
    if (onedir !== null && (onefile === null || meta?.onedirFailed !== onedir)) {
      return { build: 'onedir', sha256: onedir };
    }
    if (onefile !== null) return { build: 'onefile', sha256: onefile };
    throw new Error(`${YTDLP_FILE_NAME} is not listed in SHA2-256SUMS`);
  }

  /** Removes what an interrupted install or removal left behind (best effort). */
  async function removeLeftovers(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(binDir);
    } catch {
      return;
    }
    const leftover =
      /^yt-dlp(?:-(?:new|old)-[0-9a-f-]+(?:\.(?:tmp|exe|zip))?|\.json\.[0-9a-f-]+\.tmp)$/;
    for (const name of names) {
      if (!leftover.test(name)) continue;
      await rm(join(binDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Deletes the onedir versions other than `keep` (all of them for null), only while no yt-dlp
   * runs; a folder Windows refuses to rename is still in use and stays for next time.
   */
  async function pruneOnedir(keep: string | null): Promise<void> {
    if (!isIdle()) return;
    let names: string[];
    try {
      names = await readdir(onedirRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === keep) continue;
      let doomed = join(onedirRoot, name);
      if (!name.startsWith('old-')) {
        const aside = join(onedirRoot, `old-${randomUUID()}`);
        try {
          await rename(doomed, aside);
        } catch (err) {
          logger.warn(`keeping the onedir yt-dlp ${name} for now (in use?)`, err);
          continue;
        }
        doomed = aside;
      }
      await rm(doomed, { recursive: true, force: true }).catch((err: unknown) => {
        logger.warn('could not delete an old onedir yt-dlp', err);
      });
    }
    if (keep === null) await rmdir(onedirRoot).catch(() => undefined);
  }

  async function installOnedir(expected: string): Promise<Installed> {
    const zipPath = join(binDir, `yt-dlp-new-${randomUUID()}.zip`);
    const dir = `${expected.slice(0, 12)}-${randomBytes(4).toString('hex')}`;
    const target = join(onedirRoot, dir);
    let installed = false;
    try {
      logger.info('downloading yt-dlp (onedir build)');
      await writeFile(
        zipPath,
        await fetchCapped(YTDLP_ONEDIR_URL, BINARY_TIMEOUT_MS, YTDLP_MAX_BYTES),
      );
      // Hash what actually landed on disk: nothing is extracted from an unverified zip.
      const actual = await hashFile(zipPath);
      if (actual !== expected) {
        logger.error(
          `checksum mismatch for ${YTDLP_ONEDIR_ASSET} (expected ${expected}, got ${actual})`,
        );
        throw new YtDlpError(YTDLP_CHECKSUM_MESSAGE);
      }
      await mkdir(target, { recursive: true });
      const extractStartedAt = Date.now();
      try {
        await extractZip(zipPath, target);
      } catch (err) {
        throw new ExtractError(`could not extract ${YTDLP_ONEDIR_ASSET}`, { cause: err });
      }
      const exe = join(target, YTDLP_FILE_NAME);
      if (!existsSync(exe) || !existsSync(join(target, ...ONEDIR_MARKER))) {
        throw new ExtractError(`${YTDLP_ONEDIR_ASSET} does not hold the onedir build`);
      }
      await rm(zipPath, { force: true });
      const exeSha256 = await hashFile(exe);
      // The antivirus scans the new files now, rather than during the first song.
      const runStartedAt = Date.now();
      const version = await runVersion(exe);
      if (version === null) throw new ExtractError('the onedir yt-dlp does not run');
      await remember(exe, exeSha256);
      revision += 1;
      installed = true;
      logger.info(
        `yt-dlp ${version} installed (onedir ${dir}; extracted in ${runStartedAt - extractStartedAt} ms, first run ${Date.now() - runStartedAt} ms)`,
      );
      return { build: 'onedir', dir, sha256: expected, exeSha256 };
    } finally {
      await rm(zipPath, { force: true }).catch(() => undefined);
      if (!installed) await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Moves the verified temp file into place, even while an older yt-dlp.exe still runs. */
  async function replaceOnefile(tmp: string): Promise<void> {
    try {
      await rename(tmp, onefileExe);
      return;
    } catch (err) {
      if (!isBusy(err)) throw err;
    }
    // Windows cannot overwrite a running executable, but it can rename it.
    const aside = join(binDir, `yt-dlp-old-${randomUUID()}.exe`);
    await rename(onefileExe, aside);
    try {
      await rename(tmp, onefileExe);
    } catch (err) {
      await rename(aside, onefileExe).catch(() => undefined);
      throw err;
    }
    await rm(aside, { force: true }).catch(() => undefined);
  }

  async function installOnefile(expected: string): Promise<Installed> {
    const tmp = join(binDir, `yt-dlp-new-${randomUUID()}.tmp`);
    try {
      logger.info('downloading yt-dlp (single-file build)');
      await writeFile(tmp, await fetchCapped(YTDLP_BINARY_URL, BINARY_TIMEOUT_MS, YTDLP_MAX_BYTES));
      // Hash what actually landed on disk, and never let a mismatching file near the binary.
      const actual = await hashFile(tmp);
      if (actual !== expected) {
        logger.error(
          `checksum mismatch for ${YTDLP_FILE_NAME} (expected ${expected}, got ${actual})`,
        );
        throw new YtDlpError(YTDLP_CHECKSUM_MESSAGE);
      }
      await replaceOnefile(tmp);
      await remember(onefileExe, actual);
      revision += 1;
      logger.info(`yt-dlp installed (single file, ${actual.slice(0, 12)}…)`);
      return { build: 'onefile', sha256: actual, exeSha256: actual };
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** The wanted build, or the single-file one when the onedir cannot be installed. */
  async function installWanted(sums: ReleaseSums, want: Wanted): Promise<Installed> {
    if (want.build === 'onefile') return installOnefile(want.sha256);
    try {
      return await installOnedir(want.sha256);
    } catch (err) {
      if (sums.onefile === null) throw err;
      logger.warn('could not install the onedir yt-dlp; using the single-file build', err);
      const installed = await installOnefile(sums.onefile);
      return err instanceof ExtractError ? { ...installed, onedirFailed: want.sha256 } : installed;
    }
  }

  async function install(
    sums: ReleaseSums,
    want: Wanted,
    previous: Meta | null,
  ): Promise<Installed> {
    installing = true;
    for (const notify of waiting) notify();
    try {
      await mkdir(binDir, { recursive: true });
      await removeLeftovers();
      const installed = await installWanted(sums, want);
      // A zip that would not extract or run is remembered while the single-file build stands in.
      const onedirFailed =
        installed.onedirFailed ?? (installed.build === 'onefile' ? previous?.onedirFailed : null);
      return onedirFailed ? { ...installed, onedirFailed } : installed;
    } catch (err) {
      if (err instanceof YtDlpError) throw err;
      logger.warn('could not install yt-dlp', err);
      throw new YtDlpError(
        errorCode(err) === 'ENOSPC' ? YTDLP_NO_SPACE_MESSAGE : YTDLP_FETCH_FAILED_MESSAGE,
      );
    } finally {
      installing = false;
    }
  }

  /** After the record switched to `current`: the other build and older versions go. */
  async function removeOthers(current: Installed): Promise<void> {
    if (current.build === 'onedir') {
      if (existsSync(onefileExe)) {
        await rm(onefileExe, { force: true }).catch((err: unknown) => {
          logger.warn('could not delete the single-file yt-dlp (still running?)', err);
        });
      }
      await pruneOnedir(current.dir ?? null);
    } else {
      await pruneOnedir(null);
    }
  }

  // --- Checks ----------------------------------------------------------------------------------

  /** `use`: a real need (counts as a use, installs if missing); `warm`: the warm-up. */
  async function check(force: boolean, mode: 'use' | 'warm'): Promise<YtDlpBinary | null> {
    const startedAt = now();
    const meta = await readMeta();
    /** The record, when the very build a previous check verified is on disk unchanged. */
    const verified = meta && (await isTrusted(meta)) ? meta : null;
    const lastUse = meta ? (meta.usedAt ?? meta.checkedAt) : null;
    // Never fetched for the warm-up alone, nor kept alive by it.
    if (
      mode === 'warm' &&
      (!verified || lastUse === null || startedAt - lastUse >= YTDLP_UNUSED_MS)
    ) {
      return null;
    }
    if (verified) {
      const due = force
        ? startedAt - lastForcedCheckAt >= YTDLP_FORCED_CHECK_INTERVAL_MS
        : startedAt - verified.checkedAt >= YTDLP_CHECK_INTERVAL_MS &&
          startedAt - lastFailedCheckAt >= YTDLP_RETRY_CHECK_MS;
      if (!due) return binary(verified);
    }
    if (force) lastForcedCheckAt = startedAt;

    let sums: ReleaseSums;
    let want: Wanted;
    try {
      sums = await fetchSums();
      want = wanted(sums, meta);
    } catch (err) {
      if (verified) {
        lastFailedCheckAt = startedAt;
        logger.warn('update check failed; using the verified copy', err);
        return binary(verified);
      }
      logger.warn('could not fetch SHA2-256SUMS', err);
      throw new YtDlpError(YTDLP_FETCH_FAILED_MESSAGE);
    }
    let installed: Installed;
    const upToDate = verified?.build === want.build && verified.sha256 === want.sha256;
    if (verified && upToDate) {
      installed = verified;
    } else if (
      !verified &&
      want.build === 'onefile' &&
      (await localHash(onefileExe)) === want.sha256
    ) {
      // The very release file, without a record (lost, or older than it): no need to fetch it.
      installed = { build: 'onefile', sha256: want.sha256, exeSha256: want.sha256 };
    } else {
      try {
        installed = await install(sums, want, meta);
      } catch (err) {
        // An update that failed (or raced a new release) leaves the verified copy in place.
        if (!verified) throw err;
        lastFailedCheckAt = startedAt;
        logger.warn('update failed; using the verified copy', err);
        return binary(verified);
      }
    }
    try {
      const at = now();
      await writeMeta({
        ...installed,
        checkedAt: at,
        usedAt: mode === 'use' ? at : (lastUse ?? at),
      });
      if (mode === 'use') lastUseRecordedAt = at;
      if (installed !== verified) await removeOthers(installed);
    } catch (err) {
      // Only costs an extra check (or a leftover folder) next time.
      logger.warn('could not save the yt-dlp check', err);
    }
    return binary(installed);
  }

  /** Notes in the record that the Jam needed yt-dlp now (for `removeIfUnused`). */
  async function recordUse(): Promise<void> {
    const at = now();
    if (at - lastUseRecordedAt < USE_RECORD_INTERVAL_MS) return;
    const meta = await readMeta();
    if (!meta) return;
    try {
      await writeMeta({ ...meta, usedAt: at });
      lastUseRecordedAt = at;
    } catch (err) {
      logger.warn('could not save the yt-dlp use', err);
    }
  }

  async function removeUnused(idleMs: number): Promise<boolean> {
    const meta = await readMeta();
    const exists = existsSync(onefileExe) || existsSync(onedirRoot);
    if (exists) {
      let lastUse = meta ? (meta.usedAt ?? meta.checkedAt) : Number.NEGATIVE_INFINITY;
      if (!meta) {
        for (const path of [onefileExe, onedirRoot]) {
          const info = await stat(path).catch(() => null);
          if (info) lastUse = Math.max(lastUse, info.mtimeMs);
        }
      }
      if (now() - lastUse < idleMs) {
        // Kept: only older onedir versions go.
        await pruneOnedir(meta?.build === 'onedir' ? (meta.dir ?? null) : null);
        return false;
      }
    }
    // Moved aside first: Windows refuses while a yt-dlp from it still runs (next start-up then).
    if (existsSync(onedirRoot)) {
      const aside = join(binDir, `yt-dlp-old-${randomUUID()}`);
      try {
        await rename(onedirRoot, aside);
      } catch (err) {
        logger.warn('could not remove the onedir yt-dlp (in use?)', err);
        return false;
      }
      await rm(aside, { recursive: true, force: true });
    }
    await rm(onefileExe, { force: true });
    await rm(metaPath, { force: true });
    await removeLeftovers();
    await rmdir(binDir).catch(() => undefined);
    hashes.clear();
    if (exists) logger.info(`removed yt-dlp: unused for ${Math.round(idleMs / 86_400_000)} days`);
    return exists;
  }

  /** Runs `task` after every call already on the chain. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  }

  return {
    needsInstall: () => installing || (!existsSync(onefileExe) && !existsSync(onedirRoot)),
    ensure(options = {}) {
      const { force = false, onPreparing } = options;
      if (onPreparing) {
        if (installing) onPreparing();
        waiting.add(onPreparing);
      }
      const run = serialized(async () => {
        const result = await check(force, 'use');
        // `use` checks always end with a binary or a rejection.
        if (!result) throw new YtDlpError(YTDLP_FETCH_FAILED_MESSAGE);
        await recordUse();
        return result;
      });
      return run.finally(() => {
        if (onPreparing) waiting.delete(onPreparing);
      });
    },
    warmUp: () =>
      serialized(() => check(false, 'warm')).catch((err: unknown) => {
        logger.warn('yt-dlp warm-up check failed', err);
        return null;
      }),
    removeIfUnused: (idleMs = YTDLP_UNUSED_MS) => serialized(() => removeUnused(idleMs)),
    destroy() {
      lifetime.abort();
    },
  };
}
