export type RoomId = string;

// ---------------------------------------------------------------------------
// Presence (who is in which room, who is streaming)
// ---------------------------------------------------------------------------

export interface PresenceParticipant {
  id: string;
  name: string;
  streaming: boolean;
  /** Unix epoch in milliseconds. */
  joinedAt: number;
}

export interface PresenceSnapshot {
  rooms: Record<RoomId, PresenceParticipant[]>;
}

export type PresenceEvent =
  | { type: 'snapshot'; data: PresenceSnapshot }
  | {
      type: 'participant_joined' | 'participant_left';
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
  displayName: string;
  admin: boolean;
}

export interface MeResponse {
  user: UserInfo;
}

export interface RoomsResponse {
  rooms: RoomId[];
}

export interface TokenRequest {
  room: RoomId;
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
  contentHint: 'motion' | 'detail';
}

export const QUALITY_PRESETS = {
  light: {
    label: 'Leve',
    width: 1280,
    height: 720,
    fps: 30,
    maxBitrate: 2_500_000,
    contentHint: 'detail',
  },
  standard: {
    label: 'Padrão',
    width: 1920,
    height: 1080,
    fps: 30,
    maxBitrate: 4_000_000,
    contentHint: 'detail',
  },
  game: {
    label: 'Jogo',
    width: 1920,
    height: 1080,
    fps: 60,
    maxBitrate: 6_000_000,
    contentHint: 'motion',
  },
} as const satisfies Record<string, QualityPreset>;

export type QualityPresetId = keyof typeof QUALITY_PRESETS;
