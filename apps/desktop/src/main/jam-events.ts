/**
 * Validation of the jam data that comes from concord-api: the `jam_snapshot` / `jam_updated`
 * events of the presence SSE and the tracks and items of the jam routes. Same rigor as
 * `presence-events.ts`: anything malformed is rejected (null), strings and lists are bounded and
 * unknown fields are dropped; only a bad cover URL is softened to null.
 */
import {
  JAM_HISTORY_MAX,
  JAM_QUEUE_MAX,
  ROOM_ID_PATTERN,
  YOUTUBE_VIDEO_ID_PATTERN,
  type JamEvent,
  type JamItem,
  type JamItemStatus,
  type JamNowPlaying,
  type JamRecentTrack,
  type JamSnapshot,
  type JamState,
  type JamTrack,
} from '@concord/shared';
import { JAM_ITEM_ID_PATTERN, USER_ID_PATTERN } from './validation';

/** Titles, artists and albums longer than this are not something YouTube Music sends. */
export const JAM_TEXT_MAX_LENGTH = 500;

/** Sanity bound for durations and positions (the jam itself refuses songs over 20 min). */
export const JAM_DURATION_MAX_MS = 24 * 60 * 60 * 1000;

/** More rooms than this in one snapshot is not a real server. */
export const JAM_ROOMS_MAX = 64;

const ARTWORK_URL_MAX_LENGTH = 2048;
/** Cover art hosts (the renderer CSP `img-src` must allow the same). */
const ARTWORK_HOST_SUFFIXES = ['googleusercontent.com', 'ytimg.com'];

const ITEM_STATUSES: readonly JamItemStatus[] = ['downloading', 'ready'];

export const JAM_EVENT_TYPES: readonly JamEvent['type'][] = ['jam_snapshot', 'jam_updated'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length <= JAM_TEXT_MAX_LENGTH;
}

/** Finite, non-negative: server timestamps, positions and durations. */
function isTime(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
}

function isUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}

/** An https cover on YouTube's image hosts (no credentials, default port), else null. */
export function parseArtworkUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > ARTWORK_URL_MAX_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') {
    return null;
  }
  const host = url.hostname;
  const allowed = ARTWORK_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
  return allowed ? url.href : null;
}

export function parseJamTrack(value: unknown): JamTrack | null {
  if (!isRecord(value)) return null;
  const { videoId, title, artists, album, durationMs } = value;
  if (typeof videoId !== 'string' || !YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return null;
  if (!isText(title) || !isText(artists)) return null;
  if (album !== null && !isText(album)) return null;
  if (!isTime(durationMs, JAM_DURATION_MAX_MS)) return null;
  return {
    videoId,
    title,
    artists,
    album,
    durationMs,
    artworkUrl: parseArtworkUrl(value.artworkUrl),
  };
}

/** An entry of "Recentes" (`GET /api/jam/recent`): a track and when the server last used it. */
export function parseJamRecentTrack(value: unknown): JamRecentTrack | null {
  if (!isRecord(value)) return null;
  const { usedAt } = value;
  const track = parseJamTrack(value);
  if (!track || !isTime(usedAt)) return null;
  return { ...track, usedAt };
}

export function parseJamItem(value: unknown): JamItem | null {
  if (!isRecord(value)) return null;
  const { id, requestedBy, addedAt, status } = value;
  if (typeof id !== 'string' || !JAM_ITEM_ID_PATTERN.test(id)) return null;
  const track = parseJamTrack(value.track);
  if (!track || !isUserId(requestedBy) || !isTime(addedAt)) return null;
  if (!ITEM_STATUSES.includes(status as JamItemStatus)) return null;
  return { id, track, requestedBy, addedAt, status: status as JamItemStatus };
}

function parseNowPlaying(value: unknown): JamNowPlaying | null {
  if (!isRecord(value)) return null;
  const { positionMs, at, paused, pausedBy } = value;
  const item = parseJamItem(value.item);
  if (!item || !isTime(positionMs, JAM_DURATION_MAX_MS) || !isTime(at)) return null;
  if (typeof paused !== 'boolean') return null;
  if (pausedBy !== null && !isUserId(pausedBy)) return null;
  return { item, positionMs, at, paused, pausedBy };
}

/** A list of at most `max` items, all valid; null otherwise. */
function parseJamItems(value: unknown, max: number): JamItem[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const items: JamItem[] = [];
  for (const entry of value) {
    const item = parseJamItem(entry);
    if (!item) return null;
    items.push(item);
  }
  return items;
}

/** Always sets `history` (servers from before "Música anterior" send none: empty). */
export function parseJamState(value: unknown): JamState | null {
  if (!isRecord(value)) return null;
  const { room } = value;
  if (typeof room !== 'string' || !ROOM_ID_PATTERN.test(room)) return null;
  let current: JamNowPlaying | null = null;
  if (value.current !== null) {
    current = parseNowPlaying(value.current);
    if (!current) return null;
  }
  const queue = parseJamItems(value.queue, JAM_QUEUE_MAX);
  if (!queue) return null;
  const history = value.history === undefined ? [] : parseJamItems(value.history, JAM_HISTORY_MAX);
  if (!history) return null;
  return { room, current, queue, history };
}

export function parseJamSnapshot(value: unknown): JamSnapshot | null {
  if (!isRecord(value) || !isRecord(value.rooms)) return null;
  const { available, serverTime } = value;
  if (typeof available !== 'boolean' || !isTime(serverTime)) return null;
  const entries = Object.entries(value.rooms);
  if (entries.length > JAM_ROOMS_MAX) return null;
  const rooms: JamSnapshot['rooms'] = {};
  for (const [room, raw] of entries) {
    const state = parseJamState(raw);
    // The key is the room id (ROOM_ID_PATTERN keeps `__proto__` and friends out).
    if (!state || state.room !== room) return null;
    rooms[room] = state;
  }
  return { available, rooms, serverTime };
}

/** Whether a decoded SSE payload claims to be a jam event (valid or not). */
export function isJamPayload(value: unknown): boolean {
  return isRecord(value) && JAM_EVENT_TYPES.includes(value.type as JamEvent['type']);
}

/** Validates one decoded jam SSE payload; returns null for anything malformed. */
export function parseJamEvent(value: unknown): JamEvent | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case 'jam_snapshot': {
      const data = parseJamSnapshot(value.data);
      return data ? { type: 'jam_snapshot', data } : null;
    }
    case 'jam_updated': {
      const state = parseJamState(value.state);
      if (!state || !isTime(value.serverTime)) return null;
      return { type: 'jam_updated', state, serverTime: value.serverTime };
    }
    default:
      return null;
  }
}
