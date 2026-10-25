import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createYtDlpManager,
  parseSha256Sums,
  YTDLP_BINARY_URL,
  YTDLP_CHECK_INTERVAL_MS,
  YTDLP_CHECKSUM_MESSAGE,
  YTDLP_FETCH_FAILED_MESSAGE,
  YTDLP_FORCED_CHECK_INTERVAL_MS,
  YTDLP_ONEDIR_URL,
  YTDLP_SUMS_URL,
  YTDLP_UNUSED_MS,
  YtDlpError,
  type YtDlpManagerDeps,
} from './ytdlp';

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const V1 = Buffer.from('MZ fake yt-dlp 2026.10.21');
const V2 = Buffer.from('MZ fake yt-dlp 2026.11.02 (newer)');

/** A stand-in for yt-dlp_win.zip: the files it holds, as JSON (see `fakeExtract`). */
function fakeZip(exe: string, extra: Record<string, string> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      'yt-dlp.exe': exe,
      '_internal/base_library.zip': 'PK python stdlib',
      '_internal/python310.dll': 'MZ python',
      ...extra,
    }),
  );
}

/** Unpacks a `fakeZip` like tar.exe would. */
async function fakeExtract(zipPath: string, destDir: string): Promise<void> {
  const files = JSON.parse(readFileSync(zipPath, 'utf8')) as Record<string, string>;
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(destDir, name)), { recursive: true });
    writeFileSync(join(destDir, name), content);
  }
}

/** The release as GitHub serves it; the test changes it between checks. */
function fakeGitHub() {
  const release = {
    binary: V1,
    listedHash: sha256(V1),
    /** null: the release has no onedir build. */
    zip: null as Buffer | null,
    zipListedHash: null as string | null,
    offline: false,
  };
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const name =
      url === YTDLP_SUMS_URL
        ? 'sums'
        : url === YTDLP_BINARY_URL
          ? 'binary'
          : url === YTDLP_ONEDIR_URL
            ? 'zip'
            : url;
    calls.push(name);
    if (release.offline) throw new TypeError('fetch failed');
    if (name === 'sums') {
      const zipHash = release.zipListedHash ?? (release.zip ? sha256(release.zip) : null);
      return new Response(
        [
          `${'0'.repeat(64)}  yt-dlp_x86.exe`,
          `${release.listedHash}  yt-dlp.exe`,
          ...(zipHash ? [`${zipHash}  yt-dlp_win.zip`] : []),
          `${'1'.repeat(64)}  yt-dlp_linux`,
        ].join('\n'),
      );
    }
    if (name === 'binary') return new Response(release.binary);
    if (name === 'zip' && release.zip) return new Response(release.zip);
    return new Response('', { status: 404 });
  });
  /** Ships an onedir build whose yt-dlp.exe holds `exe`. */
  const shipZip = (exe: string): void => {
    release.zip = fakeZip(exe);
    release.zipListedHash = null;
  };
  return { release, calls, fetchImpl: fetchImpl as typeof fetch, shipZip };
}

let dir: string;
let binDir: string;
let now: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concord-ytdlp-'));
  binDir = join(dir, 'bin');
  now = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function setup(overrides: Partial<YtDlpManagerDeps> = {}) {
  const github = fakeGitHub();
  const runVersion = vi.fn(async (exePath: string) => (existsSync(exePath) ? '2026.10.21' : null));
  const extractZip = vi.fn(fakeExtract);
  const manager = createYtDlpManager({
    binDir,
    fetchImpl: github.fetchImpl,
    now: () => now,
    onedir: true,
    extractZip,
    runVersion,
    ...overrides,
  });
  return {
    ...github,
    manager,
    runVersion,
    extractZip,
    exePath: join(binDir, 'yt-dlp.exe'),
  };
}

const record = () =>
  JSON.parse(readFileSync(join(binDir, 'yt-dlp.json'), 'utf8')) as {
    build?: string;
    dir?: string;
    sha256: string;
    exeSha256?: string;
    usedAt?: number;
    checkedAt: number;
    onedirFailed?: string;
  };

/** The version folders of the onedir build. */
const versions = () =>
  existsSync(join(binDir, 'yt-dlp')) ? readdirSync(join(binDir, 'yt-dlp')) : [];

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected a rejection');
}

describe('createYtDlpManager (single-file build)', () => {
  it('installs a verified binary on first use and checks again once a day', async () => {
    const { manager, calls, release, exePath } = setup();
    expect(manager.needsInstall()).toBe(true);
    const onPreparing = vi.fn();

    expect(await manager.ensure({ onPreparing })).toEqual({ path: exePath, revision: 1 });
    expect(onPreparing).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['sums', 'binary']);
    expect(readFileSync(exePath)).toEqual(V1);
    expect(manager.needsInstall()).toBe(false);
    expect(record()).toMatchObject({ build: 'onefile', sha256: sha256(V1) });

    // Within the day: no network at all.
    now += YTDLP_CHECK_INTERVAL_MS - 1;
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(calls).toHaveLength(2);

    // A day later, same release: only the checksums.
    now += 1;
    await manager.ensure();
    expect(calls).toEqual(['sums', 'binary', 'sums']);

    // A new release: downloaded and swapped in.
    release.binary = V2;
    release.listedHash = sha256(V2);
    now += YTDLP_CHECK_INTERVAL_MS;
    expect(await manager.ensure({ onPreparing })).toEqual({ path: exePath, revision: 2 });
    expect(readFileSync(exePath)).toEqual(V2);
    expect(onPreparing).toHaveBeenCalledTimes(2);
    // No temporary files left behind.
    expect(readdirSync(binDir).sort()).toEqual(['yt-dlp.exe', 'yt-dlp.json']);
  });

  it('never installs a binary whose checksum does not match', async () => {
    const { manager, release, exePath } = setup();
    release.listedHash = sha256('something else');
    const err = await rejection(manager.ensure());
    expect(err).toBeInstanceOf(YtDlpError);
    expect(err.message).toBe(YTDLP_CHECKSUM_MESSAGE);
    expect(existsSync(exePath)).toBe(false);
    expect(readdirSync(binDir)).toEqual([]);
  });

  it('keeps the verified copy when an update fails its checksum', async () => {
    const { manager, release, exePath } = setup();
    await manager.ensure();
    release.binary = V2;
    release.listedHash = sha256('not V2');
    now += YTDLP_CHECK_INTERVAL_MS;
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(readFileSync(exePath)).toEqual(V1);
  });

  it('works offline with the verified copy, but never with an unverified one', async () => {
    const { manager, release, calls, exePath } = setup();
    await manager.ensure();
    release.offline = true;
    now += YTDLP_CHECK_INTERVAL_MS;
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(calls).toEqual(['sums', 'binary', 'sums']);
    // The failed check is not retried on every song.
    await manager.ensure();
    expect(calls).toHaveLength(3);

    // Changed on disk: no longer the file that was verified.
    writeFileSync(exePath, 'MZ tampered, a different size');
    const err = await rejection(manager.ensure());
    expect(err).toBeInstanceOf(YtDlpError);
    expect(err.message).toBe(YTDLP_FETCH_FAILED_MESSAGE);
  });

  it('replaces a binary that no longer matches what was verified', async () => {
    const { manager, calls, exePath } = setup();
    await manager.ensure();
    writeFileSync(exePath, 'MZ tampered, a different size');
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 2 });
    expect(readFileSync(exePath)).toEqual(V1);
    expect(calls).toEqual(['sums', 'binary', 'sums', 'binary']);
  });

  it('refuses a binary found on disk without a record of its verification when offline', async () => {
    const { manager, release, exePath } = setup();
    // E.g. copied there by hand: only trusted once it matches the release.
    await manager.ensure();
    rmSync(join(binDir, 'yt-dlp.json'));
    release.offline = true;
    expect((await rejection(manager.ensure())).message).toBe(YTDLP_FETCH_FAILED_MESSAGE);
    release.offline = false;
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
  });

  it('runs concurrent calls one after another', async () => {
    const { manager, calls, exePath } = setup();
    const first = vi.fn();
    const second = vi.fn();
    const results = await Promise.all([
      manager.ensure({ onPreparing: first }),
      manager.ensure({ onPreparing: second }),
      manager.ensure(),
    ]);
    expect(results).toEqual([
      { path: exePath, revision: 1 },
      { path: exePath, revision: 1 },
      { path: exePath, revision: 1 },
    ]);
    expect(calls).toEqual(['sums', 'binary']);
    // The waiting call learned that yt-dlp was being fetched too.
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('forces a check on demand, at most once per interval', async () => {
    const { manager, calls, release } = setup();
    await manager.ensure();
    expect((await manager.ensure({ force: true })).revision).toBe(1);
    expect(calls).toEqual(['sums', 'binary', 'sums']);
    await manager.ensure({ force: true });
    expect(calls).toHaveLength(3);

    release.binary = V2;
    release.listedHash = sha256(V2);
    now += YTDLP_FORCED_CHECK_INTERVAL_MS;
    expect((await manager.ensure({ force: true })).revision).toBe(2);
    expect(calls).toEqual(['sums', 'binary', 'sums', 'sums', 'binary']);
  });

  it('reads the records written before the onedir build', async () => {
    const { manager, calls, exePath } = setup();
    await manager.ensure();
    writeFileSync(
      join(binDir, 'yt-dlp.json'),
      JSON.stringify({ sha256: sha256(V1), checkedAt: now, usedAt: now }),
    );
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(calls).toEqual(['sums', 'binary']);
  });
});

describe('createYtDlpManager (onedir build)', () => {
  it('installs it in a folder per version, verified before extraction, and runs it once', async () => {
    const { manager, calls, shipZip, release, extractZip, runVersion } = setup();
    shipZip('MZ onedir 2026.10.21');
    const zipHash = sha256(release.zip ?? '');
    let recordWhenRun: boolean | null = null;
    runVersion.mockImplementation(async (exePath: string) => {
      recordWhenRun = existsSync(join(binDir, 'yt-dlp.json'));
      return existsSync(exePath) ? '2026.10.21' : null;
    });
    extractZip.mockImplementation(async (zipPath, destDir) => {
      // What gets extracted is the verified file itself.
      expect(sha256(readFileSync(zipPath))).toBe(zipHash);
      expect(readdirSync(destDir)).toEqual([]);
      await fakeExtract(zipPath, destDir);
    });

    const binary = await manager.ensure();
    expect(calls).toEqual(['sums', 'zip']);
    const [version] = versions();
    expect(version).toMatch(new RegExp(`^${zipHash.slice(0, 12)}-[0-9a-f]{8}$`));
    expect(binary).toEqual({
      path: join(binDir, 'yt-dlp', version ?? '', 'yt-dlp.exe'),
      revision: 1,
    });
    expect(readFileSync(binary.path, 'utf8')).toBe('MZ onedir 2026.10.21');
    // Ran right after extracting, before the record switched to it.
    expect(runVersion).toHaveBeenCalledWith(binary.path);
    expect(recordWhenRun).toBe(false);
    expect(record()).toMatchObject({
      build: 'onedir',
      dir: version,
      sha256: zipHash,
      exeSha256: sha256('MZ onedir 2026.10.21'),
    });
    // Nothing else: no zip, no single-file build.
    expect(readdirSync(binDir).sort()).toEqual(['yt-dlp', 'yt-dlp.json']);
    expect(manager.needsInstall()).toBe(false);

    // Checked daily like the single-file build.
    now += YTDLP_CHECK_INTERVAL_MS;
    expect(await manager.ensure()).toEqual(binary);
    expect(calls).toEqual(['sums', 'zip', 'sums']);
    expect(extractZip).toHaveBeenCalledTimes(1);
  });

  it('never extracts a zip whose checksum does not match, and uses yt-dlp.exe instead', async () => {
    const { manager, calls, shipZip, release, extractZip, exePath } = setup();
    shipZip('MZ onedir 2026.10.21');
    release.zipListedHash = sha256('another zip');
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(extractZip).not.toHaveBeenCalled();
    expect(calls).toEqual(['sums', 'zip', 'binary']);
    expect(versions()).toEqual([]);
    expect(record()).toMatchObject({ build: 'onefile' });
    // A bad download is no reason to give up on the onedir build: tried again next time.
    expect(record().onedirFailed).toBeUndefined();
  });

  it('falls back to yt-dlp.exe when the zip will not extract or run, until the next release', async () => {
    const { manager, calls, shipZip, release, extractZip, runVersion, exePath } = setup();
    shipZip('MZ onedir 2026.10.21');
    const failedZip = sha256(release.zip ?? '');
    extractZip.mockRejectedValueOnce(Object.assign(new Error('tar failed'), { code: 1 }));
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(calls).toEqual(['sums', 'zip', 'binary']);
    expect(versions()).toEqual([]);
    expect(record()).toMatchObject({ build: 'onefile', onedirFailed: failedZip });

    // Same release: the zip is not fetched again.
    now += YTDLP_CHECK_INTERVAL_MS;
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(calls).toEqual(['sums', 'zip', 'binary', 'sums']);
    expect(record().onedirFailed).toBe(failedZip);

    // A new release: the onedir build gets another chance, and replaces yt-dlp.exe.
    shipZip('MZ onedir 2026.11.02');
    now += YTDLP_CHECK_INTERVAL_MS;
    const binary = await manager.ensure();
    expect(binary.path).not.toBe(exePath);
    expect(binary.revision).toBe(2);
    expect(existsSync(exePath)).toBe(false);
    expect(record()).toMatchObject({ build: 'onedir' });
    expect(record().onedirFailed).toBeUndefined();

    // A build that does not even print its version is not used either.
    const broken = setup();
    broken.shipZip('MZ onedir broken');
    broken.runVersion.mockResolvedValue(null);
    rmSync(binDir, { recursive: true, force: true });
    expect(await broken.manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(versions()).toEqual([]);
    expect(record()).toMatchObject({ build: 'onefile' });
    expect(record().onedirFailed).toBe(sha256(broken.release.zip ?? ''));
    expect(broken.runVersion).toHaveBeenCalledTimes(1);
    expect(runVersion).toHaveBeenCalledTimes(1);
  });

  it('switches versions through the record and deletes older ones once no yt-dlp runs', async () => {
    let busy = true;
    const { manager, shipZip } = setup({ isIdle: () => !busy });
    shipZip('MZ onedir 2026.10.21');
    const first = await manager.ensure();
    const [v1] = versions();

    // An update while a download runs from v1: v1 stays where it is.
    shipZip('MZ onedir 2026.11.02');
    now += YTDLP_CHECK_INTERVAL_MS;
    const second = await manager.ensure();
    expect(second.revision).toBe(2);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(first.path, 'utf8')).toBe('MZ onedir 2026.10.21');
    expect(readFileSync(second.path, 'utf8')).toBe('MZ onedir 2026.11.02');
    expect(versions()).toHaveLength(2);
    const v2 = versions().find((name) => name !== v1);
    expect(record().dir).toBe(v2);

    // The next start-up housekeeping, nothing running: only the current one is kept.
    busy = false;
    expect(await manager.removeIfUnused()).toBe(false);
    expect(versions()).toEqual([v2]);

    // An update with nothing running deletes the older version at once.
    shipZip('MZ onedir 2026.11.09');
    now += YTDLP_CHECK_INTERVAL_MS;
    const third = await manager.ensure();
    expect(versions()).toEqual([record().dir]);
    expect(readFileSync(third.path, 'utf8')).toBe('MZ onedir 2026.11.09');
  });

  it('moves from the single-file build to the onedir one when the release has it', async () => {
    const { manager, shipZip, exePath, calls } = setup();
    await manager.ensure();
    expect(existsSync(exePath)).toBe(true);
    shipZip('MZ onedir 2026.10.21');
    now += YTDLP_CHECK_INTERVAL_MS;
    const binary = await manager.ensure();
    expect(dirname(dirname(binary.path))).toBe(join(binDir, 'yt-dlp'));
    expect(existsSync(exePath)).toBe(false);
    expect(calls).toEqual(['sums', 'binary', 'sums', 'zip']);
  });

  it('trusts a version only while its executable and layout are intact', async () => {
    const { manager, shipZip, calls } = setup();
    shipZip('MZ onedir 2026.10.21');
    const first = await manager.ensure();

    writeFileSync(first.path, 'MZ tampered');
    const second = await manager.ensure();
    expect(second.revision).toBe(2);
    expect(readFileSync(second.path, 'utf8')).toBe('MZ onedir 2026.10.21');

    rmSync(join(dirname(second.path), '_internal', 'base_library.zip'));
    const third = await manager.ensure();
    expect(third.revision).toBe(3);
    expect(existsSync(join(dirname(third.path), '_internal', 'base_library.zip'))).toBe(true);
    expect(calls).toEqual(['sums', 'zip', 'sums', 'zip', 'sums', 'zip']);
  });

  it('never follows a record that points outside its folder', async () => {
    const { manager, shipZip, calls } = setup();
    shipZip('MZ onedir 2026.10.21');
    const binary = await manager.ensure();
    writeFileSync(
      join(binDir, 'yt-dlp.json'),
      JSON.stringify({ ...record(), dir: '..\\..\\elsewhere' }),
    );
    const again = await manager.ensure();
    expect(again.path).not.toContain('elsewhere');
    expect(again.revision).toBe(binary.revision + 1);
    expect(calls).toEqual(['sums', 'zip', 'sums', 'zip']);
  });

  it('sticks to yt-dlp.exe where the onedir build is not wanted', async () => {
    const { manager, shipZip, exePath, calls } = setup({ onedir: false });
    shipZip('MZ onedir 2026.10.21');
    expect(await manager.ensure()).toEqual({ path: exePath, revision: 1 });
    expect(calls).toEqual(['sums', 'binary']);
  });

  it.runIf(process.platform === 'win32')(
    'extracts the real zip format with Windows’ tar.exe',
    async () => {
      const source = join(dir, 'source');
      mkdirSync(join(source, '_internal'), { recursive: true });
      writeFileSync(join(source, 'yt-dlp.exe'), 'MZ real zip');
      writeFileSync(join(source, '_internal', 'base_library.zip'), 'PK stdlib');
      const zipPath = join(dir, 'yt-dlp_win.zip');
      const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
      execFileSync(tar, ['-a', '-c', '-f', zipPath, '-C', source, 'yt-dlp.exe', '_internal']);
      const github = fakeGitHub();
      github.release.zip = readFileSync(zipPath);
      const runVersion = vi.fn(async () => '2026.10.21');
      const manager = createYtDlpManager({
        binDir,
        fetchImpl: github.fetchImpl,
        now: () => now,
        onedir: true,
        runVersion,
      });
      const binary = await manager.ensure();
      expect(readFileSync(binary.path, 'utf8')).toBe('MZ real zip');
      expect(
        readFileSync(join(dirname(binary.path), '_internal', 'base_library.zip'), 'utf8'),
      ).toBe('PK stdlib');
      expect(record()).toMatchObject({ build: 'onedir' });
    },
  );
});

describe('warmUp', () => {
  it('never fetches yt-dlp for the warm-up alone', async () => {
    const { manager, calls } = setup();
    expect(await manager.warmUp()).toBeNull();
    expect(calls).toEqual([]);
    expect(existsSync(binDir)).toBe(false);
  });

  it('checks the installed one without counting as a use', async () => {
    const { manager, calls, shipZip } = setup();
    shipZip('MZ onedir 2026.10.21');
    const binary = await manager.ensure();
    const usedAt = record().usedAt;

    now += 2 * 60 * 60 * 1000;
    expect(await manager.warmUp()).toEqual(binary);
    expect(record().usedAt).toBe(usedAt);

    // Its daily check updates yt-dlp, still without counting as a use.
    shipZip('MZ onedir 2026.11.02');
    now += YTDLP_CHECK_INTERVAL_MS;
    const updated = await manager.warmUp();
    expect(updated?.revision).toBe(2);
    expect(calls).toEqual(['sums', 'zip', 'sums', 'zip']);
    expect(record().usedAt).toBe(usedAt);
    expect(record().checkedAt).toBe(now);

    // About to be deleted for lack of use: left alone.
    now = (usedAt ?? 0) + YTDLP_UNUSED_MS;
    expect(await manager.warmUp()).toBeNull();
    expect(calls).toHaveLength(4);
  });
});

describe('removeIfUnused', () => {
  const usedAt = () => record().usedAt;

  it('deletes yt-dlp after 30 days without use, and only then', async () => {
    const { manager, exePath } = setup();
    await manager.ensure();
    expect(usedAt()).toBe(now);

    now += YTDLP_UNUSED_MS - 1;
    expect(await manager.removeIfUnused()).toBe(false);
    expect(existsSync(exePath)).toBe(true);

    now += 1;
    expect(await manager.removeIfUnused()).toBe(true);
    expect(existsSync(binDir)).toBe(false);
    expect(manager.needsInstall()).toBe(true);

    // Fetched again on demand.
    expect((await manager.ensure()).revision).toBe(2);
    expect(existsSync(exePath)).toBe(true);
  });

  it('deletes the onedir build and its older versions too', async () => {
    const { manager, shipZip } = setup({ isIdle: () => false });
    shipZip('MZ onedir 2026.10.21');
    await manager.ensure();
    shipZip('MZ onedir 2026.11.02');
    now += YTDLP_CHECK_INTERVAL_MS;
    await manager.ensure();
    expect(versions()).toHaveLength(2);
    // Leftovers of an interrupted install.
    writeFileSync(join(binDir, 'yt-dlp-new-0b5e1c9a-1d2e-4f3a-8b7c-6d5e4f3a2b1c.zip'), 'PK');

    now += YTDLP_UNUSED_MS;
    expect(await manager.removeIfUnused()).toBe(true);
    expect(existsSync(binDir)).toBe(false);
    expect(manager.needsInstall()).toBe(true);
  });

  it('counts every use, not just the daily checks', async () => {
    const { manager, calls } = setup();
    await manager.ensure();
    const firstUse = now;
    // Within the day, no check: still a use (written at most hourly).
    now += 10 * 60 * 1000;
    await manager.ensure();
    expect(usedAt()).toBe(firstUse);
    now += 60 * 60 * 1000;
    await manager.ensure();
    expect(usedAt()).toBe(now);
    expect(calls).toEqual(['sums', 'binary']);

    now += YTDLP_UNUSED_MS - 1;
    expect(await manager.removeIfUnused()).toBe(false);
  });

  it('falls back to the last check, then to the file date, for older records', async () => {
    const { manager, exePath } = setup();
    await manager.ensure();
    writeFileSync(
      join(binDir, 'yt-dlp.json'),
      JSON.stringify({ sha256: sha256(V1), checkedAt: now }),
    );
    now += YTDLP_UNUSED_MS;
    expect(await manager.removeIfUnused()).toBe(true);

    // No record at all: the file's own date (just written) tells.
    now = Date.now();
    await manager.ensure();
    rmSync(join(binDir, 'yt-dlp.json'));
    expect(await manager.removeIfUnused()).toBe(false);
    expect(existsSync(exePath)).toBe(true);
    // The file date lands a few ms after `now` was read.
    now += YTDLP_UNUSED_MS + 60_000;
    expect(await manager.removeIfUnused()).toBe(true);
    expect(existsSync(exePath)).toBe(false);
  });

  it('removes an orphan record without a binary', async () => {
    const { manager } = setup();
    await manager.ensure();
    rmSync(join(binDir, 'yt-dlp.exe'));
    expect(await manager.removeIfUnused()).toBe(false);
    expect(existsSync(binDir)).toBe(false);
  });
});

describe('parseSha256Sums', () => {
  const hash = 'ab'.repeat(32);

  it('finds the exact file name', () => {
    expect(
      parseSha256Sums(`${'0'.repeat(64)}  yt-dlp_x86.exe\n${hash}  yt-dlp.exe\n`, 'yt-dlp.exe'),
    ).toBe(hash);
    expect(parseSha256Sums(`${hash.toUpperCase()} *yt-dlp.exe\r\n`, 'yt-dlp.exe')).toBe(hash);
    expect(parseSha256Sums(`${hash} *yt-dlp_win.zip\n`, 'yt-dlp_win.zip')).toBe(hash);
  });

  it('returns null when the file is missing or the hash is malformed', () => {
    expect(parseSha256Sums(`${hash}  yt-dlp_x86.exe`, 'yt-dlp.exe')).toBeNull();
    expect(parseSha256Sums(`${hash}  yt-dlp_win_x86.zip`, 'yt-dlp_win.zip')).toBeNull();
    expect(parseSha256Sums(`${hash.slice(2)}  yt-dlp.exe`, 'yt-dlp.exe')).toBeNull();
    expect(parseSha256Sums('<html>rate limited</html>', 'yt-dlp.exe')).toBeNull();
  });
});
