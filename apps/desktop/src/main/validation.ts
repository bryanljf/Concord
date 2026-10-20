import {
  NICKNAME_MAX_LENGTH,
  QUALITY_PRESETS,
  ROOM_ID_PATTERN,
  type QualityPresetId,
  type RoomId,
  type TokenPurpose,
} from '@concord/shared';
import type { MusicAppId, PipResizeCorner, PipTarget } from '../preload/api';
import { isMusicAppId } from './music-apps';

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

export function expectQualityPresetId(value: unknown, name = 'quality'): QualityPresetId {
  if (typeof value !== 'string' || !Object.hasOwn(QUALITY_PRESETS, value)) {
    throw new IpcValidationError(name);
  }
  return value as QualityPresetId;
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

export function expectMusicAppId(value: unknown, name = 'app'): MusicAppId {
  if (!isMusicAppId(value)) throw new IpcValidationError(name);
  return value;
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
