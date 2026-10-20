import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { QUALITY_PRESETS, type UserInfo } from '@concord/shared';
import type { Settings } from '../preload/api';
import { parseUserInfo } from './api-client';
import { log } from './log';

const logger = log('settings');

/** Empty unless a build sets VITE_DEFAULT_SERVER: the server address is shared privately. */
export const DEFAULT_SERVER_URL = import.meta.env.VITE_DEFAULT_SERVER ?? '';

/** Prefix used when `safeStorage` cannot encrypt (e.g. Linux without a keyring). */
const PLAIN_PREFIX = 'plain:';

export function defaultSettings(): Settings {
  return {
    serverUrl: DEFAULT_SERVER_URL,
    launchAtLogin: true,
    followDiscord: true,
    shortcut: 'CommandOrControl+Shift+L',
    defaultQuality: 'standard',
    codec: 'h264',
    mutedRooms: [],
    mutedUsers: [],
    viewerSounds: true,
    roomSounds: true,
    audioOutputDeviceId: null,
    trayNoticeShown: false,
    cameraDeviceId: null,
    pipAlwaysOnTop: true,
    pipLayout: 'vertical',
    pipTileWidth: 320,
    pipPosition: null,
    musicSounds: true,
    sidebarCollapsed: false,
  };
}

/** Accepted `pipTileWidth` range; the PiP window clamps it further to the screen. */
export const PIP_TILE_WIDTH_RANGE = { min: 120, max: 4000 } as const;

/** Thrown by `update()` when the renderer sends a field with the wrong shape. */
export class SettingsValidationError extends Error {
  override readonly name = 'SettingsValidationError';
  constructor(readonly field: string) {
    super(`Configuração inválida: ${field}.`);
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Validator<K extends keyof Settings> = (value: unknown) => Settings[K] | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const boolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : undefined;

const nullableString = (value: unknown): string | null | undefined =>
  value === null || typeof value === 'string' ? value : undefined;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Null, or a screen point with finite coordinates (rounded to whole pixels). */
const screenPoint = (value: unknown): { x: number; y: number } | null | undefined => {
  if (value === null) return null;
  if (!isRecord(value) || !isFiniteNumber(value.x) || !isFiniteNumber(value.y)) return undefined;
  return { x: Math.round(value.x), y: Math.round(value.y) };
};

const validators: { [K in keyof Settings]: Validator<K> } = {
  serverUrl: (value) => (isHttpUrl(value) ? value : undefined),
  launchAtLogin: boolean,
  followDiscord: boolean,
  shortcut: (value) => (typeof value === 'string' && value.length <= 64 ? value : undefined),
  defaultQuality: (value) =>
    typeof value === 'string' && Object.hasOwn(QUALITY_PRESETS, value)
      ? (value as Settings['defaultQuality'])
      : undefined,
  codec: (value) =>
    value === 'h264' || value === 'vp9' || value === 'av1'
      ? (value as Settings['codec'])
      : undefined,
  mutedRooms: stringList,
  mutedUsers: stringList,
  viewerSounds: boolean,
  roomSounds: boolean,
  audioOutputDeviceId: nullableString,
  trayNoticeShown: boolean,
  cameraDeviceId: nullableString,
  pipAlwaysOnTop: boolean,
  pipLayout: (value) => (value === 'vertical' || value === 'horizontal' ? value : undefined),
  pipTileWidth: (value) =>
    isFiniteNumber(value) && value >= PIP_TILE_WIDTH_RANGE.min && value <= PIP_TILE_WIDTH_RANGE.max
      ? Math.round(value)
      : undefined,
  pipPosition: screenPoint,
  musicSounds: boolean,
  sidebarCollapsed: boolean,
};

const SETTINGS_KEYS = Object.keys(validators) as (keyof Settings)[];

/**
 * Builds a full `Settings` from untrusted data: every missing, unknown or invalid field falls
 * back to `base`. Returns the names of the rejected fields for logging.
 */
export function sanitizeSettings(
  raw: unknown,
  base: Settings = defaultSettings(),
): { settings: Settings; rejected: string[] } {
  const settings = { ...base };
  const rejected: string[] = [];
  if (!isRecord(raw)) return { settings, rejected: ['*'] };
  for (const key of SETTINGS_KEYS) {
    if (!(key in raw)) continue;
    const value = validators[key](raw[key]);
    if (value === undefined) {
      rejected.push(key);
    } else {
      // The validator for `key` is typed to return `Settings[key]`.
      (settings as Record<string, unknown>)[key] = value;
    }
  }
  return { settings, rejected };
}

/** Validates a partial update coming from the renderer; throws on the first invalid field. */
export function sanitizePatch(raw: unknown): Partial<Settings> {
  if (!isRecord(raw)) throw new SettingsValidationError('patch');
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(validators, key)) throw new SettingsValidationError(key);
    const valid = validators[key as keyof Settings](value);
    if (valid === undefined) throw new SettingsValidationError(key);
    patch[key] = valid;
  }
  return patch as Partial<Settings>;
}

/**
 * The user kept in `settings.json`, validated with the same rules as the server response:
 * `avatarUrl` only from cdn.discordapp.com, `discordName`/`nickname` strings, missing → null.
 */
export function sanitizeUser(raw: unknown): UserInfo | null {
  return parseUserInfo(raw);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** Shape of `settings.json` on disk: the preferences plus the session secrets. */
interface StoredFile extends Settings {
  /** `safeStorage.encryptString(key)` in base64, or `plain:<key>` when encryption is unavailable. */
  encryptedKey?: string;
  /** Last user returned by `/api/me`, kept so the session survives an offline startup. */
  user?: UserInfo;
}

export type SettingsListener = (next: Settings, previous: Settings) => void;

export interface SettingsStore {
  readonly filePath: string;
  get(): Settings;
  /** Validates, merges, persists and notifies listeners. Throws `SettingsValidationError`. */
  update(patch: Partial<Settings>): Settings;
  onChange(listener: SettingsListener): () => void;
  /** Decrypted access key, or null when none is stored or it cannot be decrypted. */
  getKey(): string | null;
  setKey(key: string): void;
  clearKey(): void;
  getUser(): UserInfo | null;
  setUser(user: UserInfo | null): void;
}

export interface SettingsStoreOptions {
  /** Defaults to `<userData>/settings.json`. */
  filePath?: string;
}

function encryptKey(key: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(key).toString('base64');
  }
  logger.warn('safeStorage encryption unavailable; storing the access key without encryption');
  return PLAIN_PREFIX + key;
}

function decryptKey(stored: string): string | null {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  } catch (err) {
    logger.warn('stored access key could not be decrypted; ignoring it', err);
    return null;
  }
}

function readFile(filePath: string): {
  settings: Settings;
  encryptedKey?: string;
  user?: UserInfo;
} {
  if (!existsSync(filePath)) return { settings: defaultSettings() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    logger.warn(`could not parse ${filePath}; using defaults`, err);
    return { settings: defaultSettings() };
  }
  const { settings, rejected } = sanitizeSettings(raw);
  if (rejected.length > 0) logger.warn(`invalid fields reset to defaults: ${rejected.join(', ')}`);
  const record = isRecord(raw) ? raw : {};
  const result: { settings: Settings; encryptedKey?: string; user?: UserInfo } = { settings };
  if (typeof record.encryptedKey === 'string' && record.encryptedKey !== '') {
    result.encryptedKey = record.encryptedKey;
  }
  const user = sanitizeUser(record.user);
  if (user) result.user = user;
  return result;
}

/** Writes atomically: the JSON goes to a temp file that is then renamed over the target. */
function writeFileAtomic(filePath: string, data: StoredFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, filePath);
}

export function createSettingsStore(options: SettingsStoreOptions = {}): SettingsStore {
  const filePath = options.filePath ?? join(app.getPath('userData'), 'settings.json');
  const loaded = readFile(filePath);
  let settings = loaded.settings;
  let encryptedKey = loaded.encryptedKey;
  let user = loaded.user ?? null;
  /** Cache of the decrypted key; `undefined` means "not decrypted yet". */
  let keyCache: string | null | undefined;
  const listeners = new Set<SettingsListener>();

  function persist(): void {
    const data: StoredFile = { ...settings };
    if (encryptedKey !== undefined) data.encryptedKey = encryptedKey;
    if (user) data.user = user;
    try {
      writeFileAtomic(filePath, data);
    } catch (err) {
      logger.error(`could not write ${filePath}`, err);
    }
  }

  return {
    filePath,
    get: () => settings,
    update(patch) {
      const clean = sanitizePatch(patch);
      const previous = settings;
      settings = { ...previous, ...clean };
      persist();
      for (const listener of listeners) listener(settings, previous);
      return settings;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getKey() {
      if (keyCache === undefined) {
        keyCache = encryptedKey === undefined ? null : decryptKey(encryptedKey);
        // Upgrade a key stored in plain text once encryption becomes available.
        if (
          keyCache !== null &&
          encryptedKey?.startsWith(PLAIN_PREFIX) &&
          safeStorage.isEncryptionAvailable()
        ) {
          encryptedKey = encryptKey(keyCache);
          persist();
          logger.info('access key re-encrypted with safeStorage');
        }
      }
      return keyCache;
    },
    setKey(key) {
      encryptedKey = encryptKey(key);
      keyCache = key;
      persist();
    },
    clearKey() {
      encryptedKey = undefined;
      keyCache = null;
      persist();
    },
    getUser: () => user,
    setUser(next) {
      user = next;
      persist();
    },
  };
}
