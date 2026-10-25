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
// Streaming quality: any resolution × frame rate
// ---------------------------------------------------------------------------

/** Heights a live can be captured at (16:9). */
export const STREAM_RESOLUTIONS = [480, 720, 1080, 1440] as const;
export type StreamResolution = (typeof STREAM_RESOLUTIONS)[number];

export const STREAM_FRAME_RATES = [15, 30, 60] as const;
export type StreamFrameRate = (typeof STREAM_FRAME_RATES)[number];

/** "1080p30": what a live is captured and encoded at (settings, IPC and the picker). */
export type StreamQualityId = `${StreamResolution}p${StreamFrameRate}`;

export interface StreamQuality {
  id: StreamQualityId;
  width: number;
  height: StreamResolution;
  fps: StreamFrameRate;
  /** Cap of the top simulcast layer (bps). */
  maxBitrate: number;
}

const STREAM_WIDTHS: Record<StreamResolution, number> = {
  480: 854,
  720: 1280,
  1080: 1920,
  1440: 2560,
};

/**
 * Bitrate caps (bps). The former presets keep theirs (720p30 2.5, 1080p30 4, 1080p60 6 Mbps);
 * the rest scale from them: 15 fps ≈ 0.6×, 60 fps ≈ 1.5× the 30 fps cap.
 */
const STREAM_BITRATES: Record<StreamResolution, Record<StreamFrameRate, number>> = {
  480: { 15: 800_000, 30: 1_200_000, 60: 1_800_000 },
  720: { 15: 1_500_000, 30: 2_500_000, 60: 3_800_000 },
  1080: { 15: 2_500_000, 30: 4_000_000, 60: 6_000_000 },
  1440: { 15: 4_000_000, 30: 6_500_000, 60: 9_500_000 },
};

export const DEFAULT_STREAM_QUALITY: StreamQualityId = '1080p30';

/** The fixed presets before v0.2.1, still found in saved settings. */
const LEGACY_QUALITY_PRESETS: Record<string, StreamQualityId> = {
  light: '720p30',
  standard: '1080p30',
  game: '1080p60',
};

export function streamQualityId(
  resolution: StreamResolution,
  fps: StreamFrameRate,
): StreamQualityId {
  return `${resolution}p${fps}`;
}

/** A valid id as is, a former preset ("standard") as its id, anything else null. */
export function parseStreamQualityId(value: unknown): StreamQualityId | null {
  if (typeof value !== 'string') return null;
  const legacy = Object.hasOwn(LEGACY_QUALITY_PRESETS, value)
    ? LEGACY_QUALITY_PRESETS[value]
    : undefined;
  if (legacy) return legacy;
  const match = /^(\d+)p(\d+)$/.exec(value);
  if (!match) return null;
  const height = Number(match[1]);
  const fps = Number(match[2]);
  const resolution = STREAM_RESOLUTIONS.find((candidate) => candidate === height);
  const frameRate = STREAM_FRAME_RATES.find((candidate) => candidate === fps);
  return resolution !== undefined && frameRate !== undefined
    ? streamQualityId(resolution, frameRate)
    : null;
}

export function streamQualityOf(id: StreamQualityId): StreamQuality {
  const [height, fps] = id.split('p').map(Number) as [StreamResolution, StreamFrameRate];
  return {
    id,
    width: STREAM_WIDTHS[height],
    height,
    fps,
    maxBitrate: STREAM_BITRATES[height][fps],
  };
}

/**
 * Human label for a room id, shown instead of the raw id: "sala-1" → "Sala 1",
 * "jogos_fds" → "Jogos fds". Ids are restricted to ROOM_ID_PATTERN, so labels are derived.
 */
export function roomLabel(room: RoomId): string {
  const words = room.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export * from './jam';
