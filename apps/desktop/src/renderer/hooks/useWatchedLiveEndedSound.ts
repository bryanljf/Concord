import { useEffect, useRef } from 'react';
import type { RoomId } from '@concord/shared';
import type { RemoteStream } from './useRemoteStreams';
import { playTransmissionEnded } from '../lib/transmissionSounds';
import { endedWatchedLives } from '../lib/watching';

/**
 * Plays the "transmissão encerrada" chime (the one the streamer hears) when a live you watch goes
 * off the air. Only while connected: a reconnect briefly drops every stream and must stay quiet.
 */
export function useWatchedLiveEndedSound(
  streams: readonly RemoteStream[],
  watchedIds: readonly string[],
  currentRoom: RoomId | null,
  connected: boolean,
): void {
  const previous = useRef<{ room: RoomId; liveWatched: string[] } | null>(null);

  useEffect(() => {
    if (!connected || currentRoom === null) {
      previous.current = null;
      return;
    }
    const liveIds = new Set(streams.map((stream) => stream.participantId));
    const prev = previous.current;
    previous.current = {
      room: currentRoom,
      liveWatched: watchedIds.filter((id) => liveIds.has(id)),
    };
    if (prev?.room !== currentRoom) return;
    if (endedWatchedLives(prev.liveWatched, liveIds).length > 0) playTransmissionEnded();
  }, [streams, watchedIds, currentRoom, connected]);
}
