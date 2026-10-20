import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
  userDataDir: '',
  encryptionAvailable: true,
}));

vi.mock('electron', () => ({
  app: { getPath: () => electronMock.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => electronMock.encryptionAvailable,
    encryptString: (text: string) => Buffer.from(`enc(${text})`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc(')) throw new Error('not encrypted by us');
      return text.slice(4, -1);
    },
  },
}));

import {
  createSettingsStore,
  defaultSettings,
  sanitizePatch,
  sanitizeSettings,
  sanitizeUser,
  SettingsValidationError,
} from './settings';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'concord-settings-'));
  electronMock.userDataDir = dir;
  electronMock.encryptionAvailable = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readStored(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>;
}

describe('sanitizeSettings', () => {
  it('falls back to defaults per invalid or unknown field', () => {
    const { settings, rejected } = sanitizeSettings({
      serverUrl: 'ftp://nope',
      launchAtLogin: false,
      followDiscord: 'yes',
      shortcut: 'Alt+L',
      defaultQuality: 'ultra',
      codec: 'vp9',
      mutedRooms: ['jogos', 7, 'jogos'],
      mutedUsers: 'ana',
      audioOutputDeviceId: 'dev-1',
      trayNoticeShown: true,
      somethingElse: 1,
    });
    expect(settings).toEqual({
      ...defaultSettings(),
      launchAtLogin: false,
      shortcut: 'Alt+L',
      codec: 'vp9',
      mutedRooms: ['jogos'],
      audioOutputDeviceId: 'dev-1',
      trayNoticeShown: true,
    });
    expect(rejected).toEqual(['serverUrl', 'followDiscord', 'defaultQuality', 'mutedUsers']);
  });

  it('returns defaults for non-objects', () => {
    expect(sanitizeSettings(null).settings).toEqual(defaultSettings());
    expect(sanitizeSettings([1]).settings).toEqual(defaultSettings());
  });
});

describe('camera and picture-in-picture settings', () => {
  it('has the documented defaults', () => {
    expect(defaultSettings()).toMatchObject({
      cameraDeviceId: null,
      pipAlwaysOnTop: true,
      pipLayout: 'vertical',
      pipTileWidth: 320,
      pipPosition: null,
    });
  });

  it('validates and normalises each field', () => {
    expect(
      sanitizePatch({
        cameraDeviceId: 'cam-1',
        pipAlwaysOnTop: false,
        pipLayout: 'horizontal',
        pipTileWidth: 480.6,
        pipPosition: { x: 10.4, y: -20.6 },
      }),
    ).toEqual({
      cameraDeviceId: 'cam-1',
      pipAlwaysOnTop: false,
      pipLayout: 'horizontal',
      pipTileWidth: 481,
      pipPosition: { x: 10, y: -21 },
    });
    expect(sanitizePatch({ cameraDeviceId: null, pipPosition: null })).toEqual({
      cameraDeviceId: null,
      pipPosition: null,
    });
    expect(sanitizePatch({ pipTileWidth: 120, pipPosition: { x: 0, y: 0, z: 1 } })).toEqual({
      pipTileWidth: 120,
      pipPosition: { x: 0, y: 0 },
    });
  });

  it('rejects bad values', () => {
    const bad: Record<string, unknown>[] = [
      { cameraDeviceId: 7 },
      { pipAlwaysOnTop: 'yes' },
      { pipLayout: 'grid' },
      { pipTileWidth: 119 },
      { pipTileWidth: 4001 },
      { pipTileWidth: Number.NaN },
      { pipTileWidth: Number.POSITIVE_INFINITY },
      { pipTileWidth: '320' },
      { pipPosition: { x: 1 } },
      { pipPosition: { x: 1, y: Number.NaN } },
      { pipPosition: [1, 2] },
      { pipPosition: 'top-right' },
    ];
    for (const patch of bad) expect(() => sanitizePatch(patch)).toThrow(SettingsValidationError);
  });

  it('resets invalid stored values to the defaults', () => {
    const { settings, rejected } = sanitizeSettings({
      pipTileWidth: 10_000,
      pipPosition: { x: 'a', y: 2 },
      pipLayout: 'horizontal',
    });
    expect(settings).toMatchObject({
      pipTileWidth: 320,
      pipPosition: null,
      pipLayout: 'horizontal',
    });
    expect(rejected).toEqual(['pipTileWidth', 'pipPosition']);
  });
});

describe('music settings', () => {
  it('plays the music chime by default', () => {
    expect(defaultSettings().musicSounds).toBe(true);
  });

  it('accepts only booleans', () => {
    expect(sanitizePatch({ musicSounds: false })).toEqual({ musicSounds: false });
    expect(() => sanitizePatch({ musicSounds: 'no' })).toThrow(SettingsValidationError);
    expect(() => sanitizePatch({ musicSounds: null })).toThrow(SettingsValidationError);
  });

  it('keeps the stored value and resets a broken one', () => {
    expect(sanitizeSettings({ musicSounds: false }).settings.musicSounds).toBe(false);
    const { settings, rejected } = sanitizeSettings({ musicSounds: 1 });
    expect(settings.musicSounds).toBe(true);
    expect(rejected).toEqual(['musicSounds']);
  });
});

describe('sidebar settings', () => {
  it('starts with the rooms sidebar expanded', () => {
    expect(defaultSettings().sidebarCollapsed).toBe(false);
  });

  it('accepts only booleans', () => {
    expect(sanitizePatch({ sidebarCollapsed: true })).toEqual({ sidebarCollapsed: true });
    expect(() => sanitizePatch({ sidebarCollapsed: 'yes' })).toThrow(SettingsValidationError);
    expect(() => sanitizePatch({ sidebarCollapsed: null })).toThrow(SettingsValidationError);
  });

  it('keeps the stored value, resets a broken one and fills it in for older files', () => {
    expect(sanitizeSettings({ sidebarCollapsed: true }).settings.sidebarCollapsed).toBe(true);
    const { settings, rejected } = sanitizeSettings({ sidebarCollapsed: 0 });
    expect(settings.sidebarCollapsed).toBe(false);
    expect(rejected).toEqual(['sidebarCollapsed']);
    expect(sanitizeSettings({ roomSounds: false }).settings.sidebarCollapsed).toBe(false);
  });
});

describe('sanitizePatch', () => {
  it('throws on unknown or invalid fields and keeps valid ones', () => {
    expect(sanitizePatch({ followDiscord: false, mutedUsers: ['ana'] })).toEqual({
      followDiscord: false,
      mutedUsers: ['ana'],
    });
    expect(() => sanitizePatch({ nope: 1 })).toThrow(SettingsValidationError);
    expect(() => sanitizePatch({ shortcut: 5 })).toThrow('Configuração inválida: shortcut.');
    expect(() => sanitizePatch('x')).toThrow(SettingsValidationError);
  });
});

describe('createSettingsStore', () => {
  it('uses <userData>/settings.json and starts from defaults', () => {
    const store = createSettingsStore();
    expect(store.filePath).toBe(join(dir, 'settings.json'));
    expect(store.get()).toEqual(defaultSettings());
    expect(store.getKey()).toBeNull();
    expect(store.getUser()).toBeNull();
    expect(existsSync(store.filePath)).toBe(false);
  });

  it('persists updates atomically and notifies listeners', () => {
    const store = createSettingsStore();
    const calls: [string, string][] = [];
    const unsubscribe = store.onChange((next, previous) => {
      calls.push([previous.shortcut, next.shortcut]);
    });
    const next = store.update({ shortcut: 'Alt+T', mutedRooms: ['filme'] });
    expect(next.shortcut).toBe('Alt+T');
    expect(store.get()).toBe(next);
    expect(calls).toEqual([['CommandOrControl+Shift+L', 'Alt+T']]);
    expect(readStored()).toMatchObject({ shortcut: 'Alt+T', mutedRooms: ['filme'] });
    expect(readdirSync(dir)).toEqual(['settings.json']);

    unsubscribe();
    store.update({ shortcut: 'Alt+U' });
    expect(calls).toHaveLength(1);

    const reloaded = createSettingsStore();
    expect(reloaded.get()).toEqual({
      ...defaultSettings(),
      shortcut: 'Alt+U',
      mutedRooms: ['filme'],
    });
  });

  it('rejects invalid patches without touching the file', () => {
    const store = createSettingsStore();
    expect(() => store.update({ codec: 'h265' as 'h264' })).toThrow(SettingsValidationError);
    expect(existsSync(store.filePath)).toBe(false);
  });

  it('repairs invalid fields and ignores unknown ones when loading', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ serverUrl: 'https://concord.example', launchAtLogin: 'no', foo: 1 }),
    );
    const store = createSettingsStore();
    expect(store.get()).toEqual({ ...defaultSettings(), serverUrl: 'https://concord.example' });
  });

  it('falls back to defaults when the file is not valid JSON', () => {
    writeFileSync(join(dir, 'settings.json'), '{ not json');
    expect(createSettingsStore().get()).toEqual(defaultSettings());
  });

  it('stores the key encrypted (never in plain text) and the user alongside', () => {
    const store = createSettingsStore();
    store.setKey('super-secret-key');
    store.setUser({ id: 'bryan', displayName: 'Bryan', admin: false });
    const stored = readStored();
    expect(JSON.stringify(stored)).not.toContain('super-secret-key');
    expect(Buffer.from(stored.encryptedKey as string, 'base64').toString('utf8')).toBe(
      'enc(super-secret-key)',
    );
    expect(stored.user).toEqual({ id: 'bryan', displayName: 'Bryan', admin: false });

    const reloaded = createSettingsStore();
    expect(reloaded.getKey()).toBe('super-secret-key');
    // Fields an older user record lacks come back as null after a reload.
    expect(reloaded.getUser()).toEqual({
      id: 'bryan',
      displayName: 'Bryan',
      admin: false,
      avatarUrl: null,
      discordName: null,
      nickname: null,
    });

    reloaded.clearKey();
    reloaded.setUser(null);
    expect(reloaded.getKey()).toBeNull();
    expect(readStored()).not.toHaveProperty('encryptedKey');
    expect(readStored()).not.toHaveProperty('user');
  });

  it('falls back to a plain: prefix when encryption is unavailable, and upgrades later', () => {
    electronMock.encryptionAvailable = false;
    const store = createSettingsStore();
    store.setKey('k1');
    expect(readStored().encryptedKey).toBe('plain:k1');
    expect(createSettingsStore().getKey()).toBe('k1');

    electronMock.encryptionAvailable = true;
    const upgraded = createSettingsStore();
    expect(upgraded.getKey()).toBe('k1');
    expect(readStored().encryptedKey).not.toBe('plain:k1');
    expect(createSettingsStore().getKey()).toBe('k1');
  });

  it('treats an undecryptable key as absent', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ encryptedKey: Buffer.from('garbage').toString('base64') }),
    );
    expect(createSettingsStore().getKey()).toBeNull();
  });
});

describe('sanitizeUser', () => {
  const avatarUrl = 'https://cdn.discordapp.com/avatars/123/abc.png';

  it('keeps avatarUrl, discordName and nickname', () => {
    const user = {
      id: 'bryan',
      displayName: 'Bryzinho',
      admin: true,
      avatarUrl,
      discordName: 'Bryan',
      nickname: 'Bryzinho',
    };
    expect(sanitizeUser({ ...user, secret: 'x' })).toEqual(user);
  });

  it('drops avatars outside cdn.discordapp.com and wrongly typed names', () => {
    expect(
      sanitizeUser({
        id: 'bryan',
        displayName: 'Bryan',
        avatarUrl: 'file:///C:/evil.png',
        discordName: ['Bryan'],
        nickname: false,
      }),
    ).toEqual({
      id: 'bryan',
      displayName: 'Bryan',
      admin: false,
      avatarUrl: null,
      discordName: null,
      nickname: null,
    });
    expect(sanitizeUser({ id: 'bryan' })).toBeNull();
    expect(sanitizeUser('bryan')).toBeNull();
  });

  it('round-trips the profile through settings.json', () => {
    const store = createSettingsStore();
    store.setKey('k');
    store.setUser({
      id: 'bryan',
      displayName: 'Bryzinho',
      admin: false,
      avatarUrl,
      discordName: 'Bryan',
      nickname: 'Bryzinho',
    });
    expect(createSettingsStore().getUser()).toEqual({
      id: 'bryan',
      displayName: 'Bryzinho',
      admin: false,
      avatarUrl,
      discordName: 'Bryan',
      nickname: 'Bryzinho',
    });
  });
});
