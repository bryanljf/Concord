import { useEffect, useRef } from 'react';
import type { RoomId } from '@concord/shared';
import type { RemoteStream } from './useRemoteStreams';
import { isCameraKey } from '../lib/streamKey';
import { playTransmissionEnded } from '../lib/transmissionSounds';

/**
 * Plays the "transmissão encerrada" chime (the one the streamer hears) when a live you watch goes
 * off the air. Only screen shares count: a watched webcam turning off stays quiet. Only while
 * connected: a reconnect briefly drops every stream and must stay quiet.
 *
 * @param watchedKeys stream keys you watch (screen keys = participant ids; cameras are ignored).
 */
export function useWatchedLiveEndedSound(
  streams: readonly RemoteStream[],
  watchedKeys: readonly string[],
  currentRoom: RoomId | null,
  connected: boolean,
): void {
  const previous = useRef<{ room: RoomId; liveWatched: string[] } | null>(null);

  useEffect(() => {
    if (!connected || currentRoom === null) {
      previous.current = null;
      return;
    }
    const liveKeys = new Set(
      streams.filter((stream) => stream.kind === 'screen').map((stream) => stream.key),
    );
    const prev = previous.current;
    previous.current = {
      room: currentRoom,
      liveWatched: watchedKeys.filter((key) => !isCameraKey(key) && liveKeys.has(key)),
    };
    if (prev?.room !== currentRoom) return;
    // Watched and live before, gone now; unwatching a live that is still on never counts.
    if (prev.liveWatched.some((key) => !liveKeys.has(key))) playTransmissionEnded();
  }, [streams, watchedKeys, currentRoom, connected]);
}
