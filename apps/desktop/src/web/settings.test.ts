import { describe, expect, it } from 'vitest';
import type { Settings } from '../preload/api';
import { memoryStorage } from './fakes';
import {
  createSettingsStore,
  defaultSettings,
  sanitizePatch,
  sanitizeSettings,
  SETTINGS_STORAGE_KEY,
  SettingsValidationError,
  type StorageLike,
} from './settings';

const ORIGIN = 'https://concord.test';

function stored(map: Map<string, string>): unknown {
  const raw = map.get(SETTINGS_STORAGE_KEY);
  return raw === undefined ? undefined : JSON.parse(raw);
}

describe('createSettingsStore', () => {
  it('starts from the desktop defaults with this origin as the server', () => {
    const { storage, map } = memoryStorage();
    const store = createSettingsStore({ serverUrl: ORIGIN, storage: () => storage });
    expect(store.get()).toEqual(defaultSettings(ORIGIN));
    expect(store.get().serverUrl).toBe(ORIGIN);
    // Nothing is written until something changes.
    expect(map.size).toBe(0);
  });

  it('persists the whole object on update and notifies listeners', () => {
    const { storage, map } = memoryStorage();
    const store = createSettingsStore({ serverUrl: ORIGIN, storage: () => storage });
    const seen: [Settings, Settings][] = [];
    store.onChange((next, previous) => seen.push([next, previous]));
    const next = store.update({ viewerSounds: false, mutedRooms: ['jogos', 'jogos'] });
    expect(next.viewerSounds).toBe(false);
    expect(next.mutedRooms).toEqual(['jogos']);
    expect(stored(map)).toEqual(next);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(next);
    expect(seen[0]?.[1].viewerSounds).toBe(true);
  });

  it('restores a stored object, field by field, ignoring the stored server', () => {
    const { storage } = memoryStorage({
      [SETTINGS_STORAGE_KEY]: JSON.stringify({
        serverUrl: 'http://somewhere.else',
        codec: 'vp9',
        viewerSounds: false,
        defaultQuality: 'standard',
        pipTileWidth: 1,
        shortcut: 7,
        unknown: true,
      }),
    });
    const store = createSettingsStore({ serverUrl: ORIGIN, storage: () => storage });
    const settings = store.get();
    expect(settings.serverUrl).toBe(ORIGIN);
    expect(settings.codec).toBe('vp9');
    expect(settings.viewerSounds).toBe(false);
    // A former preset name reads as its resolution × fps.
    expect(settings.defaultQuality).toBe('1080p30');
    // Invalid values go back to their defaults; unknown keys are dropped.
    expect(settings.pipTileWidth).toBe(320);
    expect(settings.shortcut).toBe('CommandOrControl+Shift+L');
    expect('unknown' in settings).toBe(false);
  });

  it('keeps the origin as the server even when a patch sets another', () => {
    const { storage } = memoryStorage();
    const store = createSettingsStore({ serverUrl: ORIGIN, storage: () => storage });
    expect(store.update({ serverUrl: 'http://other' }).serverUrl).toBe(ORIGIN);
  });

  it('uses the defaults for corrupt or non-object entries', () => {
    for (const raw of ['{not json', '[]', '"text"', 'null']) {
      const { storage } = memoryStorage({ [SETTINGS_STORAGE_KEY]: raw });
      const store = createSettingsStore({ serverUrl: ORIGIN, storage: () => storage });
      expect(store.get()).toEqual(defaultSettings(ORIGIN));
    }
  });

  it('works without storage, or with one that throws', () => {
    const none = createSettingsStore({ serverUrl: ORIGIN, storage: () => null });
    expect(none.update({ roomSounds: false }).roomSounds).toBe(false);

    const throwing = createSettingsStore({
      serverUrl: ORIGIN,
      storage: () => {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(throwing.get()).toEqual(defaultSettings(ORIGIN));
    expect(throwing.update({ roomSounds: false }).roomSounds).toBe(false);

    const full: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    const quota = createSettingsStore({ serverUrl: ORIGIN, storage: () => full });
    expect(quota.update({ musicSounds: false }).musicSounds).toBe(false);
    expect(quota.get().musicSounds).toBe(false);
  });

  it('rejects an invalid patch without changing anything', () => {
    const { storage, map } = memoryStorage();
    const store = createSettingsStore({ serverUrl: ORIGIN, storage: () => storage });
    expect(() => store.update({ codec: 'h265' } as unknown as Partial<Settings>)).toThrow(
      SettingsValidationError,
    );
    expect(() => store.update({ nope: 1 } as unknown as Partial<Settings>)).toThrow(
      'Configuração inválida: nope.',
    );
    expect(map.size).toBe(0);
    expect(store.get()).toEqual(defaultSettings(ORIGIN));
  });
});

describe('sanitizeSettings / sanitizePatch', () => {
  it('rejects everything that is not an object', () => {
    const base = defaultSettings(ORIGIN);
    expect(sanitizeSettings(null, base)).toEqual({ settings: base, rejected: ['*'] });
    expect(sanitizeSettings([], base).rejected).toEqual(['*']);
    expect(() => sanitizePatch('x')).toThrow(SettingsValidationError);
  });

  it('validates every field with the desktop rules', () => {
    const base = defaultSettings(ORIGIN);
    const { settings, rejected } = sanitizeSettings(
      {
        pipPosition: { x: 10.4, y: 20.6 },
        pipLayout: 'diagonal',
        audioOutputDeviceId: null,
        cameraDeviceId: 42,
        videoEncoder: 'gpu',
        mutedUsers: ['ana', 3, 'ana'],
      },
      base,
    );
    expect(settings.pipPosition).toEqual({ x: 10, y: 21 });
    expect(settings.pipLayout).toBe('vertical');
    expect(settings.audioOutputDeviceId).toBeNull();
    expect(settings.cameraDeviceId).toBeNull();
    expect(settings.videoEncoder).toBe('gpu');
    expect(settings.mutedUsers).toEqual(['ana']);
    // In the order the fields are declared.
    expect(rejected).toEqual(['cameraDeviceId', 'pipLayout']);
  });
});
