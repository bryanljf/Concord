import { useEffect, useRef } from 'react';
import { concord } from '../lib/concord';
import { shouldPlayLiveStarted, type LiveSoundContext } from '../lib/liveSound';
import { playLiveStartedInRoom } from '../lib/transmissionSounds';

/**
 * Plays a short chime when someone else goes live in the room you are connected to (presence
 * `stream_started`), unless the room or the person is muted in Settings → Sons.
 */
export function useLiveStartedSound(context: LiveSoundContext): void {
  const latest = useRef(context);
  useEffect(() => {
    latest.current = context;
  }, [context]);

  useEffect(
    () =>
      concord().onPresenceEvent((event) => {
        if (shouldPlayLiveStarted(event, latest.current)) playLiveStartedInRoom();
      }),
    [],
  );
}
