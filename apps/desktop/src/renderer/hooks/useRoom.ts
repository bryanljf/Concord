import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomId, TokenPurpose, TokenResponse } from '@concord/shared';
import { ConnectionState, DisconnectReason, Room, RoomEvent } from 'livekit-client';
import { concord, toErrorMessage } from '../lib/concord';

export type RoomConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface UseRoom {
  /** The livekit Room (stable for the life of the hook); other hooks subscribe to its events. */
  room: Room;
  /** Room the user chose (kept while connecting and after an unexpected disconnect). */
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  error: string | null;
  /** Participant whose stream the user asked to watch. */
  focusedParticipantId: string | null;
  /** False when the browser blocked audio playback: call `startAudio()` from a user gesture. */
  audioPlayback: boolean;
  /** Leaves the previous room (if any), requests a token and connects. Resolves true when connected. */
  join(roomId: RoomId, focusParticipantId?: string | null): Promise<boolean>;
  leave(): Promise<void>;
  focus(participantId: string | null): void;
  startAudio(): Promise<void>;
}

export interface UseRoomOptions {
  /** `popout` asks concord-api for the hidden, subscribe-only identity. */
  purpose?: TokenPurpose;
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
export function disconnectMessage(reason: DisconnectReason | undefined): string | null {
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

/**
 * Room options (SPEC 5.6): adaptive stream picks the simulcast layer from the size of the
 * attached <video>, dynacast lets the publisher pause layers nobody watches, and the Web Audio
 * mix routes every remote audio track through an AudioContext + GainNode so per-stream volume
 * can go above 100 % and the output device can be switched with `AudioContext.setSinkId`.
 */
export function createRoom(): Room {
  return new Room({ adaptiveStream: true, dynacast: true, webAudioMix: true });
}

export function useRoom(options: UseRoomOptions = {}): UseRoom {
  const { purpose = 'main' } = options;
  const [room] = useState(createRoom);
  // Incremented on every join/leave so stale async work can bail out.
  const sequence = useRef(0);
  const currentRoomRef = useRef<RoomId | null>(null);
  const [currentRoom, setCurrentRoom] = useState<RoomId | null>(null);
  const [connectionState, setConnectionState] = useState<RoomConnectionState>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [focusedParticipantId, setFocusedParticipantId] = useState<string | null>(null);
  const [audioPlayback, setAudioPlayback] = useState(true);

  useEffect(() => {
    const onState = (state: ConnectionState): void => {
      setConnectionState(toConnectionState(state));
    };
    const onDisconnected = (reason?: DisconnectReason): void => {
      const message = disconnectMessage(reason);
      if (message) setError(message);
    };
    const onAudioPlayback = (playing: boolean): void => setAudioPlayback(playing);
    room
      .on(RoomEvent.ConnectionStateChanged, onState)
      .on(RoomEvent.Disconnected, onDisconnected)
      .on(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback);
    return () => {
      room
        .off(RoomEvent.ConnectionStateChanged, onState)
        .off(RoomEvent.Disconnected, onDisconnected)
        .off(RoomEvent.AudioPlaybackStatusChanged, onAudioPlayback);
    };
  }, [room]);

  // Disconnect when the owner unmounts (harmless before any connect, e.g. StrictMode).
  useEffect(
    () => () => {
      sequence.current += 1;
      void room.disconnect();
    },
    [room],
  );

  const join = useCallback(
    async (roomId: RoomId, focusParticipantId: string | null = null): Promise<boolean> => {
      const alreadyThere =
        currentRoomRef.current === roomId && room.state !== ConnectionState.Disconnected;
      if (alreadyThere) {
        // Re-clicking the current room keeps the focus; a badge click re-targets it.
        if (focusParticipantId) setFocusedParticipantId(focusParticipantId);
        return room.state === ConnectionState.Connected;
      }
      setFocusedParticipantId(focusParticipantId);

      const seq = ++sequence.current;
      setError(null);
      if (room.state !== ConnectionState.Disconnected) await room.disconnect();
      if (seq !== sequence.current) return false;

      currentRoomRef.current = roomId;
      setCurrentRoom(roomId);
      setConnectionState('connecting');

      let grant: TokenResponse;
      try {
        grant = await concord().requestToken(roomId, purpose);
      } catch (err) {
        if (seq !== sequence.current) return false;
        setConnectionState('disconnected');
        setError(toErrorMessage(err, 'Não foi possível obter acesso à sala.'));
        return false;
      }
      if (seq !== sequence.current) return false;

      try {
        await room.connect(grant.url, grant.token, { autoSubscribe: false });
      } catch {
        if (seq !== sequence.current) return false;
        setConnectionState('disconnected');
        setError('Não foi possível conectar ao servidor de mídia.');
        return false;
      }
      return seq === sequence.current;
    },
    [room, purpose],
  );

  const leave = useCallback(async () => {
    sequence.current += 1;
    currentRoomRef.current = null;
    setCurrentRoom(null);
    setError(null);
    setFocusedParticipantId(null);
    setConnectionState('disconnected');
    if (room.state !== ConnectionState.Disconnected) await room.disconnect();
  }, [room]);

  const focus = useCallback((participantId: string | null) => {
    setFocusedParticipantId(participantId);
  }, []);

  const startAudio = useCallback(async () => {
    await room.startAudio();
  }, [room]);

  return {
    room,
    currentRoom,
    connectionState,
    error,
    focusedParticipantId,
    audioPlayback,
    join,
    leave,
    focus,
    startAudio,
  };
}
