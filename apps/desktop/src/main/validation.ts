import {
  JAM_SEARCH_LIMIT,
  JAM_SEARCH_MAX_LENGTH,
  NICKNAME_MAX_LENGTH,
  parseStreamQualityId,
  ROOM_ID_PATTERN,
  YOUTUBE_VIDEO_ID_PATTERN,
  type RoomId,
  type StreamQualityId,
  type TokenPurpose,
} from '@concord/shared';
import type { PipResizeCorner, PipTarget } from '../preload/api';

/**
 * Error whose `message` is pt-BR and safe to show in the UI. The IPC layer forwards it to the
 * renderer unchanged; anything else becomes a generic "erro inesperado".
 */
export class UserFacingError extends Error {
  override readonly name: string = 'UserFacingError';
}

/** Input from the renderer that fails shape validation. */
export class IpcValidationError extends UserFacingError {
  override readonly name = 'IpcValidationError';
  constructor(parameter: string) {
    super(`Parâmetro inválido: ${parameter}.`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function expectString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new IpcValidationError(name);
  return value;
}

export function expectBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new IpcValidationError(name);
  return value;
}

export function expectRoomId(value: unknown, name = 'room'): RoomId {
  const room = expectString(value, name);
  if (!ROOM_ID_PATTERN.test(room)) throw new IpcValidationError(name);
  return room;
}

/** `null` stays `null`; strings are trimmed and must fit `maxLength`. */
export function expectNullableString(
  value: unknown,
  name: string,
  maxLength: number,
): string | null {
  if (value === null) return null;
  const text = expectString(value, name).trim();
  if (text.length > maxLength) throw new IpcValidationError(name);
  return text;
}

export function expectStreamQualityId(value: unknown, name = 'quality'): StreamQualityId {
  const id = parseStreamQualityId(value);
  if (id === null) throw new IpcValidationError(name);
  return id;
}

export function expectOptionalTokenPurpose(value: unknown): TokenPurpose | undefined {
  if (value === undefined) return undefined;
  if (value === 'main' || value === 'popout' || value === 'pip') return value;
  throw new IpcValidationError('purpose');
}

/** Same rule as concord-api (`USER_ID_PATTERN` in apps/api/src/auth.ts). */
export const USER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** A room never holds more people than the picture-in-picture can show (LiveKit limit 15). */
export const MAX_PIP_PARTICIPANTS = 15;

/**
 * `openPip` / `updatePip` argument: a room and up to 15 user ids (cameras, not stream keys).
 * Duplicates are dropped, keeping the first occurrence so the order stays the watch order.
 */
export function parsePipTarget(raw: unknown): PipTarget {
  if (!isRecord(raw)) throw new IpcValidationError('target');
  const room = expectRoomId(raw.room);
  const ids = raw.participantIds;
  if (!Array.isArray(ids) || ids.length > MAX_PIP_PARTICIPANTS) {
    throw new IpcValidationError('participantIds');
  }
  const participantIds: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || !USER_ID_PATTERN.test(id)) {
      throw new IpcValidationError('participantIds');
    }
    if (!participantIds.includes(id)) participantIds.push(id);
  }
  return { room, participantIds };
}

export function expectPipResizeCorner(value: unknown): PipResizeCorner {
  if (value === 'nw' || value === 'ne' || value === 'sw' || value === 'se') return value;
  throw new IpcValidationError('corner');
}

/**
 * `setNickname` input: null or a string. The string is trimmed; blank means "use the Discord
 * name" (null); longer than `NICKNAME_MAX_LENGTH` is rejected with a pt-BR message.
 */
export function expectNickname(value: unknown): string | null {
  if (value === null) return null;
  const nickname = expectString(value, 'nickname').trim();
  if (nickname === '') return null;
  // Counted in code points, like the server (an emoji is one character).
  if ([...nickname].length > NICKNAME_MAX_LENGTH) {
    throw new UserFacingError(`O nome pode ter no máximo ${NICKNAME_MAX_LENGTH} caracteres.`);
  }
  return nickname;
}

// --- Jam ---------------------------------------------------------------------------------

/** Jam queue item ids, from the server (`jam-events.ts`) and from the renderer alike. */
export const JAM_ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function expectYouTubeVideoId(value: unknown, name = 'videoId'): string {
  const id = expectString(value, name);
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(id)) throw new IpcValidationError(name);
  return id;
}

/** `prefetchJam` input: at most a search's worth (`JAM_SEARCH_LIMIT`) of video ids. */
export function expectYouTubeVideoIds(value: unknown, name = 'videoIds'): string[] {
  if (!Array.isArray(value) || value.length > JAM_SEARCH_LIMIT) throw new IpcValidationError(name);
  return value.map((id: unknown) => expectYouTubeVideoId(id, name));
}

export function expectJamItemId(value: unknown, name = 'itemId'): string {
  const id = expectString(value, name);
  if (!JAM_ITEM_ID_PATTERN.test(id)) throw new IpcValidationError(name);
  return id;
}

/** `previousJam` input: the song playing as the renderer saw it, or null when none was. */
export function expectNullableJamItemId(value: unknown, name = 'itemId'): string | null {
  return value === null ? null : expectJamItemId(value, name);
}

/** Largest `seekJam` position (songs are far shorter; the server clamps to the song anyway). */
export const JAM_SEEK_MAX_MS = 24 * 60 * 60 * 1000;

/** `seekJam` input: whole milliseconds, 0 to `JAM_SEEK_MAX_MS`. */
export function expectJamPositionMs(value: unknown, name = 'positionMs'): number {
  const valid =
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= JAM_SEEK_MAX_MS;
  if (!valid) throw new IpcValidationError(name);
  return value;
}

/** `searchJam` input: trimmed, 1 to `JAM_SEARCH_MAX_LENGTH` characters (pt-BR errors). */
export function expectJamQuery(value: unknown): string {
  const query = expectString(value, 'query').trim();
  if (query === '') throw new UserFacingError('Digite o nome de uma música para buscar.');
  // Counted in code points, like the nickname (an emoji is one character).
  if ([...query].length > JAM_SEARCH_MAX_LENGTH) {
    throw new UserFacingError(`A busca pode ter no máximo ${JAM_SEARCH_MAX_LENGTH} caracteres.`);
  }
  return query;
}
