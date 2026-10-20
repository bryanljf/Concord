export type RoomId = string;

// ---------------------------------------------------------------------------
// Presence (who is in which room, who is streaming)
// ---------------------------------------------------------------------------

export interface PresenceParticipant {
  id: string;
  /** Display name: the user's nickname, else their Discord name, else the users.json name. */
  name: string;
  streaming: boolean;
  /** Unix epoch in milliseconds. */
  joinedAt: number;
  /** Discord avatar (cdn.discordapp.com), or null when unknown. Optional for older servers. */
  avatarUrl?: string | null;
  /** Publishing a webcam (a camera never counts as `streaming`). Optional for older servers. */
  camera?: boolean;
}

export interface PresenceSnapshot {
  rooms: Record<RoomId, PresenceParticipant[]>;
}

export type PresenceEvent =
  | { type: 'snapshot'; data: PresenceSnapshot }
  | {
      /** `participant_updated`: same person, new name, avatar and/or camera (replaced in place). */
      type: 'participant_joined' | 'participant_left' | 'participant_updated';
      room: RoomId;
      participant: PresenceParticipant;
    }
  | { type: 'stream_started' | 'stream_stopped'; room: RoomId; participantId: string };

export type PresenceEventType = PresenceEvent['type'];

/** Interval between SSE heartbeat comments sent by `/api/presence`. */
export const SSE_HEARTBEAT_MS = 25_000;

/** Applies a presence event to a snapshot, returning a new snapshot (pure). */
export function applyPresenceEvent(
  snapshot: PresenceSnapshot,
  event: PresenceEvent,
): PresenceSnapshot {
  if (event.type === 'snapshot') return event.data;
  const current = snapshot.rooms[event.room] ?? [];
  let next: PresenceParticipant[];
  switch (event.type) {
    case 'participant_joined':
      next = [...current.filter((p) => p.id !== event.participant.id), event.participant];
      break;
    case 'participant_left':
      next = current.filter((p) => p.id !== event.participant.id);
      break;
    case 'participant_updated':
      next = current.map((p) => (p.id === event.participant.id ? event.participant : p));
      break;
    case 'stream_started':
    case 'stream_stopped': {
      const streaming = event.type === 'stream_started';
      next = current.map((p) => (p.id === event.participantId ? { ...p, streaming } : p));
      break;
    }
  }
  return { rooms: { ...snapshot.rooms, [event.room]: next } };
}

// ---------------------------------------------------------------------------
// HTTP API DTOs
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
}

export interface UserInfo {
  id: string;
  /** Resolved name shown everywhere: nickname ?? discordName ?? users.json displayName. */
  displayName: string;
  admin: boolean;
  /** Discord avatar URL, or null when unknown. Optional for older servers. */
  avatarUrl?: string | null;
  /** Name as shown on Discord (global_name, else username), or null when never imported. */
  discordName?: string | null;
  /** Custom name chosen in the app, or null to use the Discord name. */
  nickname?: string | null;
}

/** `PUT /api/me/nickname`: null or an empty string clears the nickname. Responds with MeResponse. */
export interface NicknameRequest {
  nickname: string | null;
}

/** Nicknames are trimmed and must have 1 to 32 characters. */
export const NICKNAME_MAX_LENGTH = 32;

export interface MeResponse {
  user: UserInfo;
}

export interface RoomsResponse {
  rooms: RoomId[];
}

/** `GET /api/server`: where the server runs (shown next to the ping in the app). */
export interface ServerInfoResponse {
  /** Instance name: `SERVER_NAME`, the cloud instance's display name, or the host name. */
  name: string;
  /** Cloud region id (`sa-saopaulo-1`) or a free label from `SERVER_REGION`; null when unknown. */
  region: string | null;
  /** Where the region came from, so the app can name the cloud. */
  provider: 'oracle' | null;
}

/**
 * `main`: the regular participant (publishes and subscribes). `popout` / `pip`: hidden,
 * subscribe-only identities used by the pop-out window and by the cameras' picture-in-picture
 * window, so one person can hold several LiveKit connections.
 */
export type TokenPurpose = 'main' | 'popout' | 'pip';

export interface TokenRequest {
  room: RoomId;
  purpose?: TokenPurpose;
}

/** Appended to the user id for auxiliary identities (`bryan~popout`). */
export const AUXILIARY_IDENTITY_SEPARATOR = '~';

/** Auxiliary identities never appear in presence and cannot publish. */
export function isAuxiliaryIdentity(identity: string): boolean {
  return identity.includes(AUXILIARY_IDENTITY_SEPARATOR);
}

export function auxiliaryIdentity(userId: string, purpose: Exclude<TokenPurpose, 'main'>): string {
  return `${userId}${AUXILIARY_IDENTITY_SEPARATOR}${purpose}`;
}

export interface TokenResponse {
  /** LiveKit access token (JWT). */
  token: string;
  /** LiveKit server URL (ws:// or wss://) the client must connect to. */
  url: string;
  /** Unix epoch in milliseconds when the token stops being valid. */
  expiresAt: number;
}

export interface ApiErrorResponse {
  /** Machine-readable code (snake_case). */
  error: string;
  /** Human-readable message in pt-BR, safe to show in the UI. */
  message: string;
}

/** Lifetime of a LiveKit token issued by `/api/token`. */
export const TOKEN_TTL_SECONDS = 6 * 60 * 60;

/** Room names: 1–32 chars, letters/digits/`-`/`_`, must start alphanumeric. */
export const ROOM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

// ---------------------------------------------------------------------------
// Streaming quality presets
// ---------------------------------------------------------------------------

export interface QualityPreset {
  label: string;
  width: number;
  height: number;
  fps: number;
  maxBitrate: number;
}

export const QUALITY_PRESETS = {
  light: {
    label: 'Leve',
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrate: 2_500_000,
  },
  standard: {
    label: 'Padrão',
    width: 1920,
    height: 1080,
    fps: 30,
    maxBitrate: 4_000_000,
  },
  game: {
    label: 'Jogo',
    width: 1920,
    height: 1080,
    fps: 60,
    maxBitrate: 6_000_000,
  },
} as const satisfies Record<string, QualityPreset>;

export type QualityPresetId = keyof typeof QUALITY_PRESETS;

/**
 * Human label for a room id, shown instead of the raw id: "sala-1" → "Sala 1",
 * "jogos_fds" → "Jogos fds". Ids are restricted to ROOM_ID_PATTERN, so labels are derived.
 */
export function roomLabel(room: RoomId): string {
  const words = room.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
