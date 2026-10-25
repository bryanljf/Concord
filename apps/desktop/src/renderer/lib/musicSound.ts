import { userIdOf, type JamEvent, type JamSnapshot } from '@concord/shared';
import type { LiveSoundContext } from './liveSound';

export interface MusicSoundContext extends LiveSoundContext {
  /** `Settings.musicSounds`: the chime when a Jam starts in your room. */
  enabled: boolean;
}

/**
 * Whether a jam event should play the Jam's chime: a `jam_updated` where the room you are
 * connected to goes from nothing playing (no Jam, or only songs still on their way) to a song,
 * asked for by someone else, with the sound enabled and neither the room nor that person muted.
 * A song following another never counts, nor the snapshot (a Jam already playing when you open
 * the app or reconnect). Songs are asked for by a person (`requestedBy` is a user id): one you
 * added from your other device is still yours.
 */
export function shouldPlayJamStarted(
  event: JamEvent,
  previous: JamSnapshot,
  context: MusicSoundContext,
): boolean {
  if (!context.enabled || event.type !== 'jam_updated') return false;
  const { state } = event;
  if (!context.connected || context.currentRoom === null) return false;
  if (state.room !== context.currentRoom || state.current === null) return false;
  if (previous.rooms[state.room]?.current) return false;
  if (context.mutedRooms.includes(state.room)) return false;
  const requester = state.current.item.requestedBy;
  if (requester === userIdOf(context.selfId)) return false;
  return !context.mutedUsers.includes(requester);
}
