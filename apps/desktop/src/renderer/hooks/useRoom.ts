import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomId, TokenPurpose, TokenResponse } from '@concord/shared';
import { ConnectionState, DisconnectReason, Room, RoomEvent } from 'livekit-client';
import { concord, toErrorMessage } from '../lib/concord';
import {
  EMPTY_WATCHING,
  focusWatched,
  pruneWatching,
  showGrid as showWatchedGrid,
  unwatch as unwatchStream,
  watch as watchStream,
  watchAndFocus as watchAndFocusStream,
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
   * Stream key (`lib/streamKey.ts`) of the watched stream in destaque; null = the grid (or
   * nothing watched: entering a room subscribes to nothing until the user picks "Assistir").
   */
  focusedKey: string | null;
  /** Every stream the user chose to watch in this room session, in the order they were picked. */
  watchedKeys: readonly string[];
  /** False when the browser blocked audio playback: call `startAudio()` from a user gesture. */
  audioPlayback: boolean;
  /**
   * Leaves the previous room (if any), requests a token and connects. Resolves true when
   * connected. `watchKey` is an explicit choice (sidebar badge, navigation from main): that
   * stream is watched and put in destaque, also when already in the room. Switching rooms starts
   * a new session with nothing watched.
   */
  join(roomId: RoomId, watchKey?: string | null): Promise<boolean>;
  leave(): Promise<void>;
  /**
   * "Assistir" on a card: subscribes the stream and adds it to the grid; in destaque a screen
   * share also takes the stage (a webcam never does).
   */
  watch(key: string): void;
  /** Watches a stream and puts it in destaque whatever the current mode. */
  watchAndFocus(key: string): void;
  /** Stops watching (unsubscribes video and audio); removing the destaque goes back to the grid. */
  unwatch(key: string): void;
  /** Puts an already watched stream in destaque; never subscribes anything new. */
  focus(key: string): void;
  /** "Voltar à grade": leaves destaque. */
  showGrid(): void;
  /** Drops watched streams that are no longer published; call with the current remote streams. */
  syncLive(liveKeys: readonly string[]): void;
  startAudio(): Promise<void>;
}

export interface UseRoomOptions {
  /** `popout` / `pip` ask concord-api for a hidden, subscribe-only identity. */
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
    async (roomId: RoomId, watchKey: string | null = null): Promise<boolean> => {
      const alreadyThere =
        currentRoomRef.current === roomId && room.state !== ConnectionState.Disconnected;
      if (alreadyThere) {
        // Re-clicking the current room keeps what is watched; a badge click puts that live in
        // destaque.
        if (watchKey) setWatching((prev) => watchAndFocusStream(prev, watchKey));
        return room.state === ConnectionState.Connected;
      }
      // A new room session: only the explicitly chosen stream (if any) is watched.
      setWatching(watchKey ? watchAndFocusStream(EMPTY_WATCHING, watchKey) : EMPTY_WATCHING);
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

  const watch = useCallback((key: string) => {
    setWatching((prev) => watchStream(prev, key));
  }, []);

  const watchAndFocus = useCallback((key: string) => {
    setWatching((prev) => watchAndFocusStream(prev, key));
  }, []);

  const unwatch = useCallback((key: string) => {
    setWatching((prev) => unwatchStream(prev, key));
  }, []);

  const focus = useCallback((key: string) => {
    setWatching((prev) => focusWatched(prev, key));
  }, []);

  const showGrid = useCallback(() => {
    setWatching(showWatchedGrid);
  }, []);

  const syncLive = useCallback((liveKeys: readonly string[]) => {
    setWatching((prev) => pruneWatching(prev, liveKeys));
  }, []);

  const startAudio = useCallback(async () => {
    await room.startAudio();
  }, [room]);

  return {
    room,
    currentRoom,
    connectionState,
    error,
    focusedKey: watching.focused,
    watchedKeys: watching.watched,
    audioPlayback,
    join,
    leave,
    watch,
    watchAndFocus,
    unwatch,
    focus,
    showGrid,
    syncLive,
    startAudio,
  };
}
