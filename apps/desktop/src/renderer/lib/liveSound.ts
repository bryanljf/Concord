import { userIdOf, type PresenceEvent, type RoomId } from '@concord/shared';

export interface LiveSoundContext {
  /** The room this window is in (useRoom's current room). */
  currentRoom: RoomId | null;
  /** Only while actually connected to that room. */
  connected: boolean;
  /**
   * This window's LiveKit identity (`selfIdentity`): your own broadcast has its own sounds.
   * Presence ids are identities too (`bryan~web` on the phone), muted users are user ids.
   */
  selfId: string;
  /** `Settings.mutedRooms` / `Settings.mutedUsers` (user ids). */
  mutedRooms: readonly RoomId[];
  mutedUsers: readonly string[];
}

/**
 * Whether a presence event should play the "someone went live in your room" chime: a
 * `stream_started` (a live transition, never the snapshot of lives already running when you
 * joined) in the room you are connected to, by someone else, and neither the room nor the
 * person muted in Settings → Sons.
 */
export function shouldPlayLiveStarted(event: PresenceEvent, context: LiveSoundContext): boolean {
  if (event.type !== 'stream_started') return false;
  if (!context.connected || context.currentRoom === null) return false;
  if (event.room !== context.currentRoom) return false;
  if (event.participantId === context.selfId) return false;
  if (context.mutedRooms.includes(event.room)) return false;
  return !context.mutedUsers.includes(userIdOf(event.participantId));
}
