import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomId, TokenResponse } from '@concord/shared';
import { ConnectionState, DisconnectReason, Room, RoomEvent } from 'livekit-client';
import { concord, toErrorMessage } from '../lib/concord';

export type RoomConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface UseRoom {
  /** Room the user chose (kept while connecting and after an unexpected disconnect). */
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  error: string | null;
  /** Participant whose stream the user asked to watch (consumed by the stage in Phase 3). */
  focusedParticipantId: string | null;
  /** Leaves the previous room (if any), requests a token and connects. */
  join(roomId: RoomId, focusParticipantId?: string | null): Promise<void>;
  leave(): Promise<void>;
  focus(participantId: string | null): void;
}

function toConnectionState(state: ConnectionState): RoomConnectionState {
  switch (state) {
    case ConnectionState.Connected:
      return 'connected';
    case ConnectionState.Connecting:
      return 'connecting';
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return 'reconnecting';
    default:
      return 'disconnected';
  }
}

/** pt-BR message for disconnects the user did not ask for; null for client-initiated ones. */
function disconnectMessage(reason: DisconnectReason | undefined): string | null {
  switch (reason) {
    case undefined:
    case DisconnectReason.CLIENT_INITIATED:
      return null;
    case DisconnectReason.DUPLICATE_IDENTITY:
      return 'Você entrou nesta sala em outro dispositivo.';
    case DisconnectReason.PARTICIPANT_REMOVED:
      return 'Você foi removido da sala.';
    case DisconnectReason.ROOM_DELETED:
    case DisconnectReason.ROOM_CLOSED:
      return 'A sala foi encerrada.';
    case DisconnectReason.SERVER_SHUTDOWN:
      return 'O servidor de mídia foi reiniciado.';
    default:
      return 'A conexão com a sala caiu.';
  }
}

export function useRoom(): UseRoom {
  const roomRef = useRef<Room | null>(null);
  // Incremented on every join/leave so stale async work can bail out.
  const sequence = useRef(0);
  const currentRoomRef = useRef<RoomId | null>(null);
  const [currentRoom, setCurrentRoom] = useState<RoomId | null>(null);
  const [connectionState, setConnectionState] = useState<RoomConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [focusedParticipantId, setFocusedParticipantId] = useState<string | null>(null);

  const getRoom = useCallback((): Room => {
    if (roomRef.current) return roomRef.current;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      setConnectionState(toConnectionState(state));
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      const message = disconnectMessage(reason);
      if (message) setError(message);
    });
    roomRef.current = room;
    return room;
  }, []);

  useEffect(
    () => () => {
      const room = roomRef.current;
      roomRef.current = null;
      if (room) {
        room.removeAllListeners();
        void room.disconnect();
      }
    },
    [],
  );

  const join = useCallback(
    async (roomId: RoomId, focusParticipantId: string | null = null) => {
      const room = getRoom();
      const alreadyThere =
        currentRoomRef.current === roomId && room.state !== ConnectionState.Disconnected;
      if (alreadyThere) {
        // Re-clicking the current room keeps the focus; a badge click re-targets it.
        if (focusParticipantId) setFocusedParticipantId(focusParticipantId);
        return;
      }
      setFocusedParticipantId(focusParticipantId);

      const seq = ++sequence.current;
      setError(null);
      if (room.state !== ConnectionState.Disconnected) await room.disconnect();
      if (seq !== sequence.current) return;

      currentRoomRef.current = roomId;
      setCurrentRoom(roomId);
      setConnectionState('connecting');

      let grant: TokenResponse;
      try {
        grant = await concord().requestToken(roomId);
      } catch (err) {
        if (seq !== sequence.current) return;
        setConnectionState('disconnected');
        setError(toErrorMessage(err, 'Não foi possível obter acesso à sala.'));
        return;
      }
      if (seq !== sequence.current) return;

      try {
        await room.connect(grant.url, grant.token, { autoSubscribe: false });
      } catch {
        if (seq !== sequence.current) return;
        setConnectionState('disconnected');
        setError('Não foi possível conectar ao servidor de mídia.');
      }
    },
    [getRoom],
  );

  const leave = useCallback(async () => {
    sequence.current += 1;
    currentRoomRef.current = null;
    setCurrentRoom(null);
    setError(null);
    setFocusedParticipantId(null);
    setConnectionState('disconnected');
    const room = roomRef.current;
    if (room && room.state !== ConnectionState.Disconnected) await room.disconnect();
  }, []);

  const focus = useCallback((participantId: string | null) => {
    setFocusedParticipantId(participantId);
  }, []);

  return { currentRoom, connectionState, error, focusedParticipantId, join, leave, focus };
}
