import { useEffect, useRef } from 'react';
import { applyJamEvent, type JamSnapshot } from '@concord/shared';
import { concord } from '../lib/concord';
import { shouldPlayJamStarted, type MusicSoundContext } from '../lib/musicSound';
import { playJamStartedInRoom } from '../lib/transmissionSounds';

/**
 * Plays the Jam's chime when a Jam starts in the room you are connected to (nothing playing → a
 * song someone else asked for), unless it is off in Settings → Sons or the room or that person is
 * muted there. Keeps its own copy of the Jam to know what each event changed, and stays quiet
 * until it has the first one (a Jam already playing never rings).
 */
export function useJamStartedSound(context: MusicSoundContext): void {
  const latest = useRef(context);
  useEffect(() => {
    latest.current = context;
  }, [context]);

  useEffect(() => {
    const api = concord();
    let active = true;
    let ready = false;
    let snapshot: JamSnapshot = { available: false, rooms: {}, serverTime: 0 };
    // Subscribe before fetching so nothing emitted in between is lost.
    const unsubscribe = api.onJamEvent((event) => {
      if (ready && shouldPlayJamStarted(event, snapshot, latest.current)) {
        playJamStartedInRoom();
      }
      snapshot = applyJamEvent(snapshot, event);
      if (event.type === 'jam_snapshot') ready = true;
    });
    api.getJam().then(
      (initial) => {
        if (!active || ready) return;
        snapshot = initial;
        ready = true;
      },
      () => undefined,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
}
