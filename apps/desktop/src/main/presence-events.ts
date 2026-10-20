import type { PresenceEvent, PresenceParticipant, PresenceSnapshot } from '@concord/shared';
import { parseAvatarUrl } from './profile';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseParticipant(value: unknown): PresenceParticipant | null {
  if (!isRecord(value)) return null;
  const { id, name, streaming, joinedAt } = value;
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  if (typeof streaming !== 'boolean' || typeof joinedAt !== 'number') return null;
  // Optional for older servers; anything but a cdn.discordapp.com URL becomes null.
  const participant: PresenceParticipant = {
    id,
    name,
    streaming,
    joinedAt,
    avatarUrl: parseAvatarUrl(value.avatarUrl),
  };
  // Optional too (servers before v0.2.0): kept only when it is a real boolean.
  if (typeof value.camera === 'boolean') participant.camera = value.camera;
  if (typeof value.music === 'boolean') participant.music = value.music;
  return participant;
}

function parseSnapshot(value: unknown): PresenceSnapshot | null {
  if (!isRecord(value) || !isRecord(value.rooms)) return null;
  const rooms: PresenceSnapshot['rooms'] = {};
  for (const [room, list] of Object.entries(value.rooms)) {
    if (!Array.isArray(list)) return null;
    const participants: PresenceParticipant[] = [];
    for (const item of list) {
      const participant = parseParticipant(item);
      if (!participant) return null;
      participants.push(participant);
    }
    rooms[room] = participants;
  }
  return { rooms };
}

/** Validates one decoded SSE payload from `/api/presence`; returns null for anything malformed. */
export function parsePresenceEvent(value: unknown): PresenceEvent | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'snapshot': {
      const data = parseSnapshot(value.data);
      return data ? { type: 'snapshot', data } : null;
    }
    case 'participant_joined':
    case 'participant_left':
    case 'participant_updated': {
      const participant = parseParticipant(value.participant);
      if (typeof value.room !== 'string' || !participant) return null;
      return { type: value.type, room: value.room, participant };
    }
    case 'stream_started':
    case 'stream_stopped': {
      if (typeof value.room !== 'string' || typeof value.participantId !== 'string') return null;
      return { type: value.type, room: value.room, participantId: value.participantId };
    }
    default:
      return null;
  }
}
