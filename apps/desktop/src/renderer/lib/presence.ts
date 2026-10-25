import {
  userIdOf,
  type PresenceParticipant,
  type PresenceSnapshot,
  type RoomId,
} from '@concord/shared';
import type { PresenceConnectionStatus } from '../../preload/api';
import { formatRetryIn } from './format';

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/** Streaming participants first, then alphabetical (pt-BR collation). */
export function sortParticipants(
  participants: readonly PresenceParticipant[],
): PresenceParticipant[] {
  return [...participants].sort((a, b) => {
    if (a.streaming !== b.streaming) return a.streaming ? -1 : 1;
    return collator.compare(a.name, b.name) || collator.compare(a.id, b.id);
  });
}

export function participantsOf(snapshot: PresenceSnapshot, room: RoomId): PresenceParticipant[] {
  return sortParticipants(snapshot.rooms[room] ?? []);
}

export function streamersOf(snapshot: PresenceSnapshot, room: RoomId): PresenceParticipant[] {
  return participantsOf(snapshot, room).filter((p) => p.streaming);
}

/** What a room's icon shows in the collapsed sidebar. */
export interface RoomIndicators {
  /** Someone is in the room (the green dot). */
  online: boolean;
  /** Someone in it shares their screen, "AO VIVO" (the blinking red dot); webcams do not count. */
  live: boolean;
}

export function roomIndicators(participants: readonly PresenceParticipant[]): RoomIndicators {
  return {
    online: participants.length > 0,
    live: participants.some((p) => p.streaming),
  };
}

/** Every participant currently known (any room), unique by id and sorted by name. */
export function knownParticipants(snapshot: PresenceSnapshot): PresenceParticipant[] {
  const byId = new Map<string, PresenceParticipant>();
  for (const participants of Object.values(snapshot.rooms)) {
    for (const participant of participants) {
      if (!byId.has(participant.id)) byId.set(participant.id, participant);
    }
  }
  return [...byId.values()].sort(
    (a, b) => collator.compare(a.name, b.name) || collator.compare(a.id, b.id),
  );
}

/** Configured rooms first (API order), then any extra room seen in presence, alphabetically. */
export function mergeRoomIds(rooms: readonly RoomId[], snapshot: PresenceSnapshot): RoomId[] {
  const seen = new Set(rooms);
  const extra = Object.keys(snapshot.rooms)
    .filter((room) => !seen.has(room))
    .sort((a, b) => collator.compare(a, b));
  return [...rooms, ...extra];
}

/**
 * Picks the stream to show on the stage: the requested participant when they are streaming,
 * otherwise the first streamer, otherwise nothing.
 */
export function resolveFocus(
  streamers: readonly PresenceParticipant[],
  requested: string | null,
): string | null {
  if (requested && streamers.some((p) => p.id === requested)) return requested;
  return streamers[0]?.id ?? null;
}

export type StatusTone = 'online' | 'connecting' | 'error' | 'idle';

export function statusTone(status: PresenceConnectionStatus): StatusTone {
  switch (status.state) {
    case 'connected':
      return 'online';
    case 'connecting':
      return 'connecting';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

/** Short label for the status line under the user name. */
export function statusShortLabel(status: PresenceConnectionStatus): string {
  switch (status.state) {
    case 'connected':
      return 'Conectado';
    case 'connecting':
      return status.attempt > 1 ? 'Reconectando…' : 'Conectando…';
    case 'error':
      return 'Sem conexão';
    default:
      return status.reason === 'discord_closed' ? 'Discord fechado' : 'Desconectado';
  }
}

/** Full description for tooltips. */
export function statusLabel(status: PresenceConnectionStatus): string {
  switch (status.state) {
    case 'connected':
      return 'Conectado';
    case 'connecting':
      return status.attempt > 1 ? `Reconectando… (tentativa ${status.attempt})` : 'Conectando…';
    case 'error':
      return `${status.message} — nova tentativa em ${formatRetryIn(status.retryInMs)}`;
    default:
      return status.reason === 'discord_closed'
        ? 'Discord fechado — presença pausada'
        : 'Desconectado — faça login para conectar';
  }
}

/** What presence knows about a person: the resolved display name and the Discord avatar. */
export interface PresenceProfile {
  name: string;
  avatarUrl: string | null;
}

/**
 * Every participant in presence (any room) by id (their LiveKit identity), and every person by
 * user id too: someone only present from the phone (`bryan~web`) still resolves lookups made with
 * their user id (a Jam's `requestedBy`). An identity always wins over that fallback.
 */
export function presenceProfiles(snapshot: PresenceSnapshot): Map<string, PresenceProfile> {
  const profiles = new Map<string, PresenceProfile>();
  const everyone = Object.values(snapshot.rooms).flat();
  for (const participant of everyone) {
    if (profiles.has(participant.id)) continue;
    profiles.set(participant.id, {
      name: participant.name,
      avatarUrl: participant.avatarUrl ?? null,
    });
  }
  for (const participant of everyone) {
    const userId = userIdOf(participant.id);
    const profile = profiles.get(participant.id);
    if (profile && !profiles.has(userId)) profiles.set(userId, profile);
  }
  return profiles;
}

/** Someone who can be muted in Settings → Sons. */
export interface MutablePerson {
  /** User id (what `Settings.mutedUsers` holds), whatever device they are on. */
  id: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * The people offered in Settings → Sons: everyone in presence, one entry per person (the same
 * person on the PC and on the phone is one), then the muted ids nobody is online for (they still
 * need a chip so they can be unmuted). Keeps `participants`' order.
 */
export function mutablePeople(
  participants: readonly PresenceParticipant[],
  mutedUsers: readonly string[],
): MutablePerson[] {
  const byId = new Map<string, MutablePerson>();
  for (const participant of participants) {
    const id = userIdOf(participant.id);
    if (byId.has(id)) continue;
    byId.set(id, { id, name: participant.name, avatarUrl: participant.avatarUrl ?? null });
  }
  for (const id of mutedUsers) {
    if (!byId.has(id)) byId.set(id, { id, name: id, avatarUrl: null });
  }
  return [...byId.values()];
}

interface Profiled {
  participantId: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Overrides LiveKit's participant names (fixed when the token was issued) with the presence
 * name and avatar for the same identity, which follow nickname changes. Returns `items` itself
 * when nothing changes, so memoized consumers keep a stable reference.
 */
export function withPresenceProfiles<T extends Profiled>(
  items: T[],
  profiles: ReadonlyMap<string, PresenceProfile>,
): T[] {
  let changed = false;
  const next = items.map((item) => {
    const profile = profiles.get(item.participantId);
    if (!profile) return item;
    if (profile.name === item.name && profile.avatarUrl === item.avatarUrl) return item;
    changed = true;
    return { ...item, name: profile.name, avatarUrl: profile.avatarUrl };
  });
  return changed ? next : items;
}
