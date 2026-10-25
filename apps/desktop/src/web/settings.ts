/**
 * The desktop's `Settings`, kept whole in `localStorage['concord.settings']` (the only thing the
 * web stores on the phone besides the session cookie; one small JSON entry). Same validators as
 * `main/settings.ts`, which cannot be imported here (it needs Electron): every stored field is
 * checked on its own and anything unknown or invalid goes back to its default.
 */
import { DEFAULT_STREAM_QUALITY, parseStreamQualityId } from '@concord/shared';
import type { Settings } from '../preload/api';
import { log } from './log';

const logger = log('settings');

export const SETTINGS_STORAGE_KEY = 'concord.settings';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The desktop defaults; `serverUrl` is this page's origin (the web has no server choice). */
export function defaultSettings(serverUrl: string): Settings {
  return {
    serverUrl,
    launchAtLogin: true,
    followDiscord: true,
    shortcut: 'CommandOrControl+Shift+L',
    defaultQuality: DEFAULT_STREAM_QUALITY,
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
    videoEncoder: 'cpu',
  };
}

/** Accepted `pipTileWidth` range (kept for parity with the desktop; unused on the web). */
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
  defaultQuality: (value) => parseStreamQualityId(value) ?? undefined,
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
  videoEncoder: (value) => (value === 'cpu' || value === 'gpu' ? value : undefined),
};

const SETTINGS_KEYS = Object.keys(validators) as (keyof Settings)[];

/**
 * Builds a full `Settings` from untrusted data: every missing, unknown or invalid field falls
 * back to `base`. Returns the names of the rejected fields for logging.
 */
export function sanitizeSettings(
  raw: unknown,
  base: Settings,
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type SettingsListener = (next: Settings, previous: Settings) => void;

export interface WebSettingsStore {
  get(): Settings;
  /** Validates, merges, persists and notifies listeners. Throws `SettingsValidationError`. */
  update(patch: Partial<Settings>): Settings;
  onChange(listener: SettingsListener): () => void;
}

export interface WebSettingsOptions {
  /** This page's origin: always the `serverUrl`, whatever an old entry says. */
  serverUrl: string;
  /**
   * `localStorage`, fetched on every access because merely touching it can throw (private
   * browsing, storage blocked); null when there is none.
   */
  storage(): StorageLike | null;
}

export function createSettingsStore(options: WebSettingsOptions): WebSettingsStore {
  const listeners = new Set<SettingsListener>();

  function read(): Settings {
    const base = defaultSettings(options.serverUrl);
    let raw: string | null;
    try {
      raw = options.storage()?.getItem(SETTINGS_STORAGE_KEY) ?? null;
    } catch (err) {
      logger.warn('localStorage unavailable; using defaults', err);
      return base;
    }
    if (raw === null) return base;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('stored settings are not JSON; using defaults');
      return base;
    }
    const { settings, rejected } = sanitizeSettings(parsed, base);
    if (rejected.length > 0)
      logger.warn(`invalid fields reset to defaults: ${rejected.join(', ')}`);
    return { ...settings, serverUrl: options.serverUrl };
  }

  function persist(settings: Settings): void {
    try {
      options.storage()?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch (err) {
      logger.warn('could not save the settings', err);
    }
  }

  let settings = read();

  return {
    get: () => settings,
    update(patch) {
      const clean = sanitizePatch(patch);
      const previous = settings;
      settings = { ...previous, ...clean, serverUrl: options.serverUrl };
      persist(settings);
      for (const listener of listeners) listener(settings, previous);
      return settings;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
