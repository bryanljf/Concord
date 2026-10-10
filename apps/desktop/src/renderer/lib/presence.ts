import type { PresenceParticipant, PresenceSnapshot, RoomId } from '@concord/shared';
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
