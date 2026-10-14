import type { PresenceEvent, RoomId } from '@concord/shared';

export interface RoomSoundContext {
  /** The room this window is in (useRoom's current room). */
  currentRoom: RoomId | null;
  /** Only while actually connected to that room. */
  connected: boolean;
  /** The signed-in user: your own entrance and exit have their own trigger (the connection). */
  selfId: string;
}

/**
 * Which chime a presence event plays: someone else entering (`joined`) or leaving (`left`) the
 * room you are connected to. Snapshots (joining a room, presence reconnecting) never ring.
 */
export function roomSoundFor(
  event: PresenceEvent,
  context: RoomSoundContext,
): 'joined' | 'left' | null {
  if (event.type !== 'participant_joined' && event.type !== 'participant_left') return null;
  if (!context.connected || context.currentRoom === null) return null;
  if (event.room !== context.currentRoom) return null;
  if (event.participant.id === context.selfId) return null;
  return event.type === 'participant_joined' ? 'joined' : 'left';
}
