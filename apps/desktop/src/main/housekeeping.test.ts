import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanUpdaterCache,
  compareVersions,
  emptyDir,
  installerVersion,
  parseUpdaterCacheDirName,
  removeLegacyData,
  runHousekeeping,
  startHousekeeping,
} from './housekeeping';

const DESKTOP_DIR = join(__dirname, '..', '..');

let dir: string;
let resources: string;
let localAppData: string;
let appData: string;
let cacheDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concord-housekeeping-'));
  resources = join(dir, 'resources');
  localAppData = join(dir, 'Local');
  appData = join(dir, 'Roaming');
  cacheDir = join(localAppData, '@concorddesktop-updater');
  mkdirSync(resources, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(appData, { recursive: true });
  // What electron-builder writes next to the asar.
  writeFileSync(
    join(resources, 'app-update.yml'),
    "owner: bryanljf\nrepo: Concord\nprovider: github\nupdaterCacheDirName: '@concorddesktop-updater'\n",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The updater cache as left by an install of 0.2.2 plus a downloaded `pendingVersion`. */
function fillCache(pendingVersion: string | null, info?: string): void {
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, 'installer.exe'), 'MZ installer');
  writeFileSync(join(cacheDir, 'current.blockmap'), 'blockmap');
  if (pendingVersion === null) return;
  const pending = join(cacheDir, 'pending');
  mkdirSync(pending);
  const fileName = `Concord-Setup-${pendingVersion}.exe`;
  writeFileSync(join(pending, fileName), 'MZ update');
  writeFileSync(
    join(pending, 'update-info.json'),
    info ?? JSON.stringify({ fileName, sha512: 'abc', isAdminRightsRequired: false }),
  );
}

const clean = (currentVersion = '0.2.2', resourcesPath: string | null = resources) =>
  cleanUpdaterCache({ resourcesPath, localAppData, currentVersion });

describe('cleanUpdaterCache', () => {
  it('removes an already installed update and the installer kept for differential updates', async () => {
    fillCache('0.2.2');
    await clean();
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('removes an older pending update too', async () => {
    fillCache('0.2.1');
    await clean();
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('never touches a newer update waiting to be installed', async () => {
    fillCache('0.3.0');
    await clean();
    expect(existsSync(join(cacheDir, 'pending', 'Concord-Setup-0.3.0.exe'))).toBe(true);
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(true);
    expect(existsSync(join(cacheDir, 'current.blockmap'))).toBe(true);
  });

  it('removes an incomplete or unreadable pending folder', async () => {
    fillCache('0.3.0', '{not json');
    await clean();
    expect(existsSync(cacheDir)).toBe(false);

    // An interrupted download: a temp file and no update-info.json.
    mkdirSync(join(cacheDir, 'pending'), { recursive: true });
    writeFileSync(join(cacheDir, 'pending', 'temp-Concord-Setup-0.3.0.exe'), 'partial');
    await clean();
    expect(existsSync(cacheDir)).toBe(false);

    // A record whose installer is gone.
    fillCache('0.3.0');
    rmSync(join(cacheDir, 'pending', 'Concord-Setup-0.3.0.exe'));
    await clean();
    expect(existsSync(cacheDir)).toBe(false);
  });

  it('keeps everything when the pending file name does not say its version', async () => {
    fillCache(
      '0.3.0',
      JSON.stringify({ fileName: 'Concord-Setup-0.3.0.exe', sha512: 'abc' }).replace(
        'Concord-Setup-0.3.0.exe',
        'Concord Setup.exe',
      ),
    );
    writeFileSync(join(cacheDir, 'pending', 'Concord Setup.exe'), 'MZ');
    await clean();
    expect(existsSync(join(cacheDir, 'pending', 'Concord Setup.exe'))).toBe(true);
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(true);
  });

  it('removes the installer copy when nothing is pending, keeping unknown files', async () => {
    fillCache(null);
    writeFileSync(join(cacheDir, 'something-else.txt'), 'x');
    await clean();
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(false);
    expect(existsSync(join(cacheDir, 'current.blockmap'))).toBe(false);
    expect(existsSync(join(cacheDir, 'something-else.txt'))).toBe(true);
  });

  it('does nothing in development or without a usable app-update.yml', async () => {
    fillCache('0.2.2');
    await clean('0.2.2', null);
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(true);

    rmSync(join(resources, 'app-update.yml'));
    await clean();
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(true);

    writeFileSync(join(resources, 'app-update.yml'), "updaterCacheDirName: '..'\n");
    await clean();
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(true);
  });
});

describe('parseUpdaterCacheDirName', () => {
  it('reads quoted and bare names', () => {
    expect(parseUpdaterCacheDirName("updaterCacheDirName: '@concorddesktop-updater'")).toBe(
      '@concorddesktop-updater',
    );
    expect(
      parseUpdaterCacheDirName('provider: github\r\nupdaterCacheDirName: concord-updater\r\n'),
    ).toBe('concord-updater');
  });

  it('refuses anything that is not an updater cache folder name', () => {
    expect(parseUpdaterCacheDirName('provider: github')).toBeNull();
    expect(parseUpdaterCacheDirName("updaterCacheDirName: ''")).toBeNull();
    expect(parseUpdaterCacheDirName('updaterCacheDirName: ../../Documents')).toBeNull();
    expect(parseUpdaterCacheDirName('updaterCacheDirName: ..-updater')).toBeNull();
    expect(parseUpdaterCacheDirName('updaterCacheDirName: Concord')).toBeNull();
    expect(parseUpdaterCacheDirName('updaterCacheDirName: C:\\x-updater')).toBeNull();
  });
});

describe('installerVersion', () => {
  it('matches the artifactName of electron-builder.yml', () => {
    const yml = readFileSync(join(DESKTOP_DIR, 'electron-builder.yml'), 'utf8');
    const artifactName = /^\s*artifactName:\s*(\S+)\s*$/m.exec(yml)?.[1];
    expect(artifactName).toBe('Concord-Setup-${version}.${ext}');
    expect(installerVersion('Concord-Setup-0.2.2.exe')).toBe('0.2.2');
    expect(installerVersion('Concord-Setup-1.10.0-beta.2.exe')).toBe('1.10.0-beta.2');
    expect(installerVersion('Concord Setup.exe')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders like semver', () => {
    expect(compareVersions('0.2.2', '0.2.2')).toBe(0);
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('0.3.0', '0.2.22')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.2.1', '0.2.2')).toBeLessThan(0);
    expect(compareVersions('0.3.0-beta.1', '0.3.0')).toBeLessThan(0);
    expect(compareVersions('0.3.0', '0.3.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('0.3.0-beta.2', '0.3.0-beta.10')).toBeLessThan(0);
    expect(compareVersions('0.3.0-beta', '0.3.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('0.3.0-alpha', '0.3.0-beta')).toBeLessThan(0);
  });
});

describe('the uninstaller script', () => {
  it('names the same updater cache folder as electron-builder', () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf8')) as {
      name: string;
    };
    // electron-builder: sanitized package name (no path characters), lowercased, "-updater".
    const expected = `${pkg.name.replace(/[/\\?<>:*|"]/g, '').toLowerCase()}-updater`;
    const nsh = readFileSync(join(DESKTOP_DIR, 'resources', 'installer.nsh'), 'utf8');
    expect(/!define CONCORD_UPDATER_CACHE_DIR "([^"]+)"/.exec(nsh)?.[1]).toBe(expected);
    // Never during an update (the cache then holds the update being installed).
    expect(nsh).toMatch(
      /\$\{ifNot\} \$\{isUpdated\}\s+RMDir \/r "\$LOCALAPPDATA\\\$\{CONCORD_UPDATER_CACHE_DIR\}"/,
    );
  });
});

describe('removeLegacyData', () => {
  const legacy = () => join(appData, '@telao');

  it('removes the data of the former name', async () => {
    mkdirSync(join(legacy(), 'desktop'), { recursive: true });
    writeFileSync(join(legacy(), 'desktop', 'settings.json'), '{}');
    await removeLegacyData({ appData, localAppData });
    expect(existsSync(legacy())).toBe(false);
    expect(existsSync(appData)).toBe(true);
  });

  it('keeps it while a Telão installation exists', async () => {
    mkdirSync(legacy());
    mkdirSync(join(localAppData, 'Programs', '@telaodesktop'), { recursive: true });
    await removeLegacyData({ appData, localAppData });
    expect(existsSync(legacy())).toBe(true);
  });

  it('ignores a file with that name and a missing folder', async () => {
    await removeLegacyData({ appData, localAppData });
    writeFileSync(legacy(), 'not a folder');
    await removeLegacyData({ appData, localAppData });
    expect(existsSync(legacy())).toBe(true);
  });
});

describe('emptyDir', () => {
  it('removes everything but what is kept, and the folder itself once empty', async () => {
    const root = join(dir, 'tmp');
    mkdirSync(join(root, 'a', 'deep'), { recursive: true });
    mkdirSync(join(root, 'b'));
    writeFileSync(join(root, 'file'), 'x');
    await emptyDir(root, new Set([join(root, 'b')]));
    expect(existsSync(join(root, 'a'))).toBe(false);
    expect(existsSync(join(root, 'file'))).toBe(false);
    expect(existsSync(join(root, 'b'))).toBe(true);
    await emptyDir(root);
    expect(existsSync(root)).toBe(false);
    await emptyDir(root);
  });
});

describe('runHousekeeping', () => {
  it('keeps going after a failing task and never rejects', async () => {
    const after = vi.fn(async () => undefined);
    await expect(
      runHousekeeping([
        { name: 'broken', run: async () => Promise.reject(new Error('EPERM')) },
        { name: 'after', run: after },
      ]),
    ).resolves.toBeUndefined();
    expect(after).toHaveBeenCalledTimes(1);
  });
});

describe('startHousekeeping', () => {
  it('cleans the updater cache first, then the rest', async () => {
    fillCache('0.2.2');
    mkdirSync(join(appData, '@telao'));
    const task = vi.fn(async () => {
      // The updater cache is already clean when the other tasks run.
      expect(existsSync(cacheDir)).toBe(false);
    });
    const { updaterCacheCleaned, done } = startHousekeeping({
      platform: 'win32',
      resourcesPath: resources,
      appData,
      localAppData,
      currentVersion: '0.2.2',
      tasks: [{ name: 'task', run: task }],
    });
    await updaterCacheCleaned;
    expect(existsSync(cacheDir)).toBe(false);
    await done;
    expect(task).toHaveBeenCalledTimes(1);
    expect(existsSync(join(appData, '@telao'))).toBe(false);
  });

  it('leaves the Windows folders alone elsewhere', async () => {
    fillCache('0.2.2');
    mkdirSync(join(appData, '@telao'));
    const task = vi.fn(async () => undefined);
    const { done } = startHousekeeping({
      platform: 'linux',
      resourcesPath: resources,
      appData,
      localAppData,
      currentVersion: '0.2.2',
      tasks: [{ name: 'task', run: task }],
    });
    await done;
    expect(existsSync(join(cacheDir, 'installer.exe'))).toBe(true);
    expect(existsSync(join(appData, '@telao'))).toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
