import { useEffect, useRef } from 'react';
import type { RoomId } from '@concord/shared';
import { concord } from '../lib/concord';
import { roomSoundFor } from '../lib/roomSound';
import { playRoomJoined, playRoomLeft } from '../lib/transmissionSounds';
import type { RoomConnectionState } from './useRoom';

export interface RoomSoundsOptions {
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  selfId: string;
  /** `Settings.roomSounds`. */
  enabled: boolean;
}

/**
 * Voice-channel style chimes for the room you are in: someone else entering or leaving (presence
 * `participant_joined` / `participant_left`), and your own entrance (connecting, not
 * reconnecting) and exit (leaving the room; a dropped connection keeps the room and stays quiet).
 */
export function useRoomSounds({
  currentRoom,
  connectionState,
  selfId,
  enabled,
}: RoomSoundsOptions): void {
  const connected = connectionState === 'connected';
  const latest = useRef({ currentRoom, connected, selfId, enabled });
  useEffect(() => {
    latest.current = { currentRoom, connected, selfId, enabled };
  }, [currentRoom, connected, selfId, enabled]);

  useEffect(
    () =>
      concord().onPresenceEvent((event) => {
        if (!latest.current.enabled) return;
        const sound = roomSoundFor(event, latest.current);
        if (sound === 'joined') playRoomJoined();
        else if (sound === 'left') playRoomLeft();
      }),
    [],
  );

  const previous = useRef<{ room: RoomId | null; state: RoomConnectionState }>({
    room: currentRoom,
    state: connectionState,
  });
  useEffect(() => {
    const prev = previous.current;
    previous.current = { room: currentRoom, state: connectionState };
    if (!latest.current.enabled) return;
    if (prev.state === 'connecting' && connectionState === 'connected') playRoomJoined();
    else if (prev.state === 'connected' && prev.room !== null && currentRoom === null) {
      playRoomLeft();
    }
  }, [currentRoom, connectionState]);
}
