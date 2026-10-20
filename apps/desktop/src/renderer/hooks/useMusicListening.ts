import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoomId } from '@concord/shared';
import { Track, type RemoteAudioTrack } from 'livekit-client';
import {
  PENDING_LISTEN_TIMEOUT_MS,
  addListening,
  musicVolumeOf,
  pendingListenReady,
  pruneListening,
  removeListening,
  withMusicMuteToggled,
  withMusicVolume,
  type MusicVolumes,
  type PendingListen,
} from '../lib/musicListening';
import { volumeToGain, type VolumeSetting } from '../lib/volume';
import type { RemoteMusic } from './useRemoteMusic';

export interface MusicListening {
  /** Participants whose music you listen to in the current room, in the order picked. */
  listening: readonly string[];
  /** Participant being joined to listen to ("Ouvir" on a music in another room); null if none. */
  pending: string | null;
  /** "Ouvir" on a music in this room: subscribes and plays it. */
  listen(participantId: string): void;
  /** "Ouvir" on a music in another room: enters it and listens once the music shows up. */
  listenIn(room: RoomId, participantId: string): void;
  /** "Parar de ouvir": unsubscribes. */
  stop(participantId: string): void;
  /** Volume of someone's music (0–100 % in steps of 1, 50 % by default). */
  settingFor(participantId: string): VolumeSetting;
  setVolume(participantId: string, volume: number): void;
  toggleMute(participantId: string): void;
}

interface UseMusicListeningOptions {
  currentRoom: RoomId | null;
  connected: boolean;
  /** `useRemoteMusic`: the music broadcasts in the current room. */
  music: readonly RemoteMusic[];
  /** Enters a room (Workspace's `enterRoom`); resolves true once connected. */
  join(roomId: RoomId): Promise<boolean>;
  /** Resumes playback from the click (the browser may have blocked audio). */
  startAudio(): Promise<void>;
}

interface ListeningState {
  /** Room the list belongs to: listening never carries over to another room. */
  room: RoomId | null;
  ids: readonly string[];
  pending: PendingListen | null;
}

const NONE: readonly string[] = [];

/**
 * Listening to the music broadcasts on demand: the music tracks are subscribed only while you
 * listen (attached so they play through the room's Web Audio mix, which also follows the output
 * device), with a per-broadcaster volume re-applied on every (re)subscription. The list resets
 * when the room changes, and a music that goes off the air drops out of it.
 */
export function useMusicListening(options: UseMusicListeningOptions): MusicListening {
  const { currentRoom, connected, music, join, startAudio } = options;
  const [state, setState] = useState<ListeningState>({
    room: currentRoom,
    ids: NONE,
    pending: null,
  });
  const [volumes, setVolumes] = useState<MusicVolumes>(() => new Map());
  const attached = useRef(new Set<RemoteAudioTrack>());

  const available = useMemo(() => music.map((item) => item.participantId), [music]);

  // Adjusted while rendering (no effect round-trip): another room starts empty (a pending
  // "Ouvir" for that room survives), a music that ended drops out (only while connected: during a
  // reconnect livekit briefly drops everyone), and a pending "Ouvir" starts once its music shows.
  let next = state;
  if (next.room !== currentRoom) {
    next = {
      room: currentRoom,
      ids: NONE,
      pending: next.pending?.room === currentRoom ? next.pending : null,
    };
  }
  if (connected) {
    const ids = pruneListening(next.ids, available);
    if (ids !== next.ids) next = { ...next, ids };
    if (next.pending && pendingListenReady(next.pending, currentRoom, connected, available)) {
      next = { ...next, ids: addListening(next.ids, next.pending.participantId), pending: null };
    }
  }
  if (next !== state) setState(next);
  const { ids, pending } = next;

  // A pending "Ouvir" that never got there (join failed, music stopped meanwhile) is dropped.
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      setState((prev) => (prev.pending === pending ? { ...prev, pending: null } : prev));
    }, PENDING_LISTEN_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  // Subscriptions follow the list (nothing changes while reconnecting).
  useEffect(() => {
    if (!connected) return;
    for (const item of music) {
      const wanted = ids.includes(item.participantId);
      if (item.publication.isDesired !== wanted) item.publication.setSubscribed(wanted);
    }
  }, [music, ids, connected]);

  // Attach the listened tracks so they play (livekit creates a hidden <audio> element).
  useEffect(() => {
    const live = new Set<RemoteAudioTrack>();
    for (const item of music) {
      if (!item.track || !ids.includes(item.participantId)) continue;
      live.add(item.track);
      if (!attached.current.has(item.track)) {
        item.track.attach();
        attached.current.add(item.track);
      }
    }
    for (const track of attached.current) {
      if (!live.has(track)) {
        track.detach();
        attached.current.delete(track);
      }
    }
  }, [music, ids]);

  useEffect(() => {
    const tracks = attached.current;
    return () => {
      for (const track of tracks) track.detach();
      tracks.clear();
    };
  }, []);

  // The gain lives on the participant: livekit keeps it per source and re-applies it when the
  // music track is (re)subscribed.
  useEffect(() => {
    for (const item of music) {
      const gain = volumeToGain(musicVolumeOf(volumes, item.participantId));
      item.participant.setVolume(gain, Track.Source.Microphone);
    }
  }, [music, volumes]);

  const resumeAudio = useCallback(() => {
    startAudio().catch(() => undefined);
  }, [startAudio]);

  const listen = useCallback(
    (participantId: string) => {
      resumeAudio();
      setState((prev) => ({ ...prev, ids: addListening(prev.ids, participantId) }));
    },
    [resumeAudio],
  );

  const listenIn = useCallback(
    (roomId: RoomId, participantId: string) => {
      resumeAudio();
      // Picked up while rendering as soon as the room is connected and the music published.
      setState((prev) => ({ ...prev, pending: { room: roomId, participantId } }));
      if (roomId !== currentRoom || !connected) void join(roomId);
    },
    [resumeAudio, currentRoom, connected, join],
  );

  const stop = useCallback((participantId: string) => {
    setState((prev) => ({
      ...prev,
      ids: removeListening(prev.ids, participantId),
      pending: prev.pending?.participantId === participantId ? null : prev.pending,
    }));
  }, []);

  const settingFor = useCallback(
    (participantId: string) => musicVolumeOf(volumes, participantId),
    [volumes],
  );

  const setVolume = useCallback((participantId: string, volume: number) => {
    setVolumes((prev) => withMusicVolume(prev, participantId, volume));
  }, []);

  const toggleMute = useCallback((participantId: string) => {
    setVolumes((prev) => withMusicMuteToggled(prev, participantId));
  }, []);

  return {
    listening: ids,
    pending: pending?.participantId ?? null,
    listen,
    listenIn,
    stop,
    settingFor,
    setVolume,
    toggleMute,
  };
}
