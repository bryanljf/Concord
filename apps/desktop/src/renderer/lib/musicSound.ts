import type { PresenceEvent, PresenceSnapshot } from '@concord/shared';
import type { LiveSoundContext } from './liveSound';

export interface MusicSoundContext extends LiveSoundContext {
  /** `Settings.musicSounds`. */
  enabled: boolean;
}

/**
 * Whether a presence event should play the "someone started broadcasting music in your room"
 * chime: a `participant_updated` turning `music` on (it was off or unknown in `previous`, the
 * snapshot before this event) in the room you are connected to, by someone else, with the sound
 * enabled and neither the room nor the person muted in Settings → Sons. Never the snapshot (music
 * already playing when you open the app or enter the room), nor someone arriving with it on.
 */
export function shouldPlayMusicStarted(
  event: PresenceEvent,
  previous: PresenceSnapshot,
  context: MusicSoundContext,
): boolean {
  if (!context.enabled || event.type !== 'participant_updated') return false;
  if (event.participant.music !== true) return false;
  if (!context.connected || context.currentRoom === null) return false;
  if (event.room !== context.currentRoom) return false;
  const id = event.participant.id;
  if (id === context.selfId) return false;
  const before = previous.rooms[event.room]?.find((participant) => participant.id === id);
  if (!before || before.music === true) return false;
  if (context.mutedRooms.includes(event.room)) return false;
  return !context.mutedUsers.includes(id);
}
