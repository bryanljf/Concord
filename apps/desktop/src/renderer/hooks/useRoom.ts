import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomId, TokenPurpose, TokenResponse } from '@concord/shared';
import { ConnectionState, DisconnectReason, Room, RoomEvent } from 'livekit-client';
import { concord, toErrorMessage } from '../lib/concord';
import {
  EMPTY_WATCHING,
  focusWatched,
  pruneWatching,
  unwatch as unwatchLive,
  watch as watchLive,
  type WatchingState,
} from '../lib/watching';

export type RoomConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface UseRoom {
  /** The livekit Room (stable for the life of the hook); other hooks subscribe to its events. */
  room: Room;
  /** Room the user chose (kept while connecting and after an unexpected disconnect). */
  currentRoom: RoomId | null;
  connectionState: RoomConnectionState;
  error: string | null;
  /**
   * The watched live on the stage (full quality + audio). Null when nothing is watched: entering
   * a room subscribes to nothing until the user picks "Assistir".
   */
  focusedParticipantId: string | null;
  /** Every live the user chose to watch in this room session, in the order they were picked. */
  watchedParticipantIds: readonly string[];
  /** False when the browser blocked audio playback: call `startAudio()` from a user gesture. */
  audioPlayback: boolean;
  /**
   * Leaves the previous room (if any), requests a token and connects. Resolves true when
   * connected. `watchParticipantId` is an explicit choice (sidebar badge, navigation from main):
   * that live is watched and focused. Switching rooms starts a new session with nothing watched.
   */
  join(roomId: RoomId, watchParticipantId?: string | null): Promise<boolean>;
  leave(): Promise<void>;
  /** Watches a live (subscribes it) and puts it on the stage; the previous one becomes a mini tile. */
  watch(participantId: string): void;
  /** Stops watching (unsubscribes video and audio); the next watched live takes the stage. */
  unwatch(participantId: string): void;
  /** Switches the stage to an already watched live; never subscribes anything new. */
  focus(participantId: string): void;
  /** Drops watched lives that are no longer live; call with the current remote streams. */
  syncLive(liveParticipantIds: readonly string[]): void;
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
 * Room options: adaptive stream picks the simulcast layer from the size of the
 * attached <video>, dynacast lets the publisher pause layers nobody watches, and the Web Audio
 * mix routes every remote audio track through an AudioContext + GainNode for per-stream volume
 * (0–100 %, 50 % by default) and lets the output device be switched with
 * `AudioContext.setSinkId`.
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
  const [watching, setWatching] = useState<WatchingState>(EMPTY_WATCHING);
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
    async (roomId: RoomId, watchParticipantId: string | null = null): Promise<boolean> => {
      const alreadyThere =
        currentRoomRef.current === roomId && room.state !== ConnectionState.Disconnected;
      if (alreadyThere) {
        // Re-clicking the current room keeps what is watched; a badge click watches that live.
        if (watchParticipantId) setWatching((prev) => watchLive(prev, watchParticipantId));
        return room.state === ConnectionState.Connected;
      }
      // A new room session: only the explicitly chosen live (if any) is watched.
      setWatching(
        watchParticipantId ? watchLive(EMPTY_WATCHING, watchParticipantId) : EMPTY_WATCHING,
      );
      // Not "connected" from here on, so the previous room's streams never prune the new
      // session's choice (the owner only calls syncLive while connected).
      setConnectionState('connecting');

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
    setWatching(EMPTY_WATCHING);
    setConnectionState('disconnected');
    if (room.state !== ConnectionState.Disconnected) await room.disconnect();
  }, [room]);

  const watch = useCallback((participantId: string) => {
    setWatching((prev) => watchLive(prev, participantId));
  }, []);

  const unwatch = useCallback((participantId: string) => {
    setWatching((prev) => unwatchLive(prev, participantId));
  }, []);

  const focus = useCallback((participantId: string) => {
    setWatching((prev) => focusWatched(prev, participantId));
  }, []);

  const syncLive = useCallback((liveParticipantIds: readonly string[]) => {
    setWatching((prev) => pruneWatching(prev, liveParticipantIds));
  }, []);

  const startAudio = useCallback(async () => {
    await room.startAudio();
  }, [room]);

  return {
    room,
    currentRoom,
    connectionState,
    error,
    focusedParticipantId: watching.focused,
    watchedParticipantIds: watching.watched,
    audioPlayback,
    join,
    leave,
    watch,
    unwatch,
    focus,
    syncLive,
    startAudio,
  };
}
