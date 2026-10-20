import { useEffect, useRef } from 'react';
import { applyPresenceEvent, type PresenceSnapshot } from '@concord/shared';
import { concord } from '../lib/concord';
import { shouldPlayMusicStarted, type MusicSoundContext } from '../lib/musicSound';
import { playMusicStartedInRoom } from '../lib/transmissionSounds';

/**
 * Plays the music chime when someone else starts broadcasting music in the room you are
 * connected to (presence `participant_updated` turning `music` on), unless it is off in
 * Settings → Sons or the room or the person is muted there. Keeps its own copy of presence to
 * know what each event changed.
 */
export function useMusicStartedSound(context: MusicSoundContext): void {
  const latest = useRef(context);
  useEffect(() => {
    latest.current = context;
  }, [context]);

  useEffect(() => {
    const api = concord();
    let active = true;
    let snapshot: PresenceSnapshot = { rooms: {} };
    // Subscribe before fetching so nothing emitted in between is lost.
    const unsubscribe = api.onPresenceEvent((event) => {
      if (shouldPlayMusicStarted(event, snapshot, latest.current)) playMusicStartedInRoom();
      snapshot = applyPresenceEvent(snapshot, event);
    });
    api.getPresence().then(
      (state) => {
        if (active) snapshot = state.snapshot;
      },
      () => undefined,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
}
