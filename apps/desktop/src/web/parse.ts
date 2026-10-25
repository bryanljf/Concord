/**
 * Validation of what concord-api answers, the same rules as `main/api-client.ts` (which cannot
 * be imported here: it is typed against Node's `fetch`). The jam and profile parsers are pure and
 * shared with main as they are.
 */
import {
  JAM_SEARCH_LIMIT,
  YOUTUBE_VIDEO_ID_PATTERN,
  type JamEnqueueResponse,
  type JamRecentResponse,
  type JamRecentTrack,
  type JamSearchResponse,
  type JamTrack,
  type MeResponse,
  type RoomId,
  type RoomsResponse,
  type ServerInfoResponse,
  type TokenResponse,
  type UserInfo,
} from '@concord/shared';
import { parseJamItem, parseJamRecentTrack, parseJamTrack } from '../main/jam-events';
import { parseAvatarUrl, parseProfileName } from '../main/profile';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a `UserInfo` from the server. The profile fields are optional for older servers:
 * missing or malformed values become null; unknown fields are dropped.
 */
export function parseUserInfo(value: unknown): UserInfo | null {
  if (!isRecord(value)) return null;
  const { id, displayName, admin } = value;
  if (typeof id !== 'string' || typeof displayName !== 'string') return null;
  return {
    id,
    displayName,
    admin: admin === true,
    avatarUrl: parseAvatarUrl(value.avatarUrl),
    discordName: parseProfileName(value.discordName),
    nickname: parseProfileName(value.nickname),
  };
}

export function parseMe(value: unknown): UserInfo | null {
  return isRecord(value) ? parseUserInfo((value as Partial<MeResponse>).user) : null;
}

export function parseRooms(value: unknown): RoomId[] | null {
  if (!isRecord(value)) return null;
  const rooms = (value as Partial<RoomsResponse>).rooms;
  if (!Array.isArray(rooms) || !rooms.every((room) => typeof room === 'string')) return null;
  return rooms;
}

export function parseToken(value: unknown): TokenResponse | null {
  if (!isRecord(value)) return null;
  const { token, url, expiresAt } = value as Partial<TokenResponse>;
  if (typeof token !== 'string' || typeof url !== 'string' || typeof expiresAt !== 'number') {
    return null;
  }
  return { token, url, expiresAt };
}

export function parseServerInfo(value: unknown): ServerInfoResponse | null {
  if (!isRecord(value)) return null;
  const { name, region, provider } = value as Partial<ServerInfoResponse>;
  if (typeof name !== 'string' || name === '') return null;
  return {
    name,
    region: typeof region === 'string' && region !== '' ? region : null,
    provider: provider === 'oracle' ? 'oracle' : null,
  };
}

export function parseJamSearch(value: unknown): JamSearchResponse | null {
  if (!isRecord(value)) return null;
  const { results, cached } = value as Partial<JamSearchResponse>;
  if (!Array.isArray(results)) return null;
  // One odd result (a video YouTube Music describes strangely) must not sink the whole search.
  const tracks: JamTrack[] = [];
  for (const entry of results.slice(0, JAM_SEARCH_LIMIT)) {
    const track = parseJamTrack(entry);
    if (track) tracks.push(track);
  }
  const known = Array.isArray(cached)
    ? cached.filter(
        (videoId): videoId is string =>
          typeof videoId === 'string' && YOUTUBE_VIDEO_ID_PATTERN.test(videoId),
      )
    : [];
  return { results: tracks, cached: known };
}

/** Longest "Recentes" list kept (the server's 3 h cache never holds anywhere near this many). */
export const JAM_RECENT_MAX = 500;

export function parseJamRecent(value: unknown): JamRecentTrack[] | null {
  if (!isRecord(value)) return null;
  const { tracks } = value as Partial<JamRecentResponse>;
  if (!Array.isArray(tracks)) return null;
  // Like the search: one odd entry is skipped, not the whole list.
  const recent: JamRecentTrack[] = [];
  for (const entry of tracks.slice(0, JAM_RECENT_MAX)) {
    const track = parseJamRecentTrack(entry);
    if (track) recent.push(track);
  }
  return recent;
}

export function parseJamEnqueue(value: unknown): JamEnqueueResponse | null {
  if (!isRecord(value)) return null;
  const { upload } = value as Partial<JamEnqueueResponse>;
  const item = parseJamItem(value.item);
  if (!item || typeof upload !== 'boolean') return null;
  return { item, upload };
}
