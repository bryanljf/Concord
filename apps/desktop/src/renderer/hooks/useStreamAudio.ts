import { useCallback, useEffect, useRef, useState } from 'react';
import { Track, type RemoteAudioTrack, type Room } from 'livekit-client';
import {
  DEFAULT_VOLUME_SETTING,
  clampVolume,
  volumeToGain,
  type VolumeSetting,
} from '../lib/volume';
import type { RoomConnectionState } from './useRoom';
import type { RemoteStream } from './useRemoteStreams';

export interface StreamAudio {
  /** Current setting for a participant (defaults to 100 %, unmuted). */
  settingFor(participantId: string): VolumeSetting;
  setVolume(participantId: string, volume: number): void;
  setMuted(participantId: string, muted: boolean): void;
  toggleMute(participantId: string): void;
  /** pt-BR message when the chosen output device could not be used (null when fine). */
  outputError: string | null;
}

interface UseStreamAudioOptions {
  room: Room;
  connectionState: RoomConnectionState;
  streams: readonly RemoteStream[];
  /** `Settings.audioOutputDeviceId`; null = system default. */
  outputDeviceId: string | null;
}

/**
 * Playback side of SPEC 5.5/5.7: every subscribed screen-share audio track is attached (the
 * room's Web Audio mix routes it through a GainNode), per-participant volume/mute is remembered
 * for the session and re-applied on every (re)subscription, and the output device follows the
 * settings via `Room.switchActiveDevice('audiooutput')` (AudioContext.setSinkId + <audio>.setSinkId).
 */
export function useStreamAudio(options: UseStreamAudioOptions): StreamAudio {
  const { room, connectionState, streams, outputDeviceId } = options;
  const [settings, setSettings] = useState<ReadonlyMap<string, VolumeSetting>>(() => new Map());
  const [outputError, setOutputError] = useState<string | null>(null);
  const attached = useRef(new Set<RemoteAudioTrack>());

  // Attach subscribed audio tracks so they play (livekit creates a hidden <audio> element).
  useEffect(() => {
    const live = new Set<RemoteAudioTrack>();
    for (const stream of streams) {
      const track = stream.audioTrack;
      if (!track) continue;
      live.add(track);
      if (!attached.current.has(track)) {
        track.attach();
        attached.current.add(track);
      }
    }
    for (const track of attached.current) {
      if (!live.has(track)) {
        track.detach();
        attached.current.delete(track);
      }
    }
  }, [streams]);

  useEffect(() => {
    const tracks = attached.current;
    return () => {
      for (const track of tracks) track.detach();
      tracks.clear();
    };
  }, []);

  // Apply the gain on the participant: livekit remembers it per source and re-applies it when
  // the audio track is (re)subscribed, so a focus change never resets the volume.
  useEffect(() => {
    for (const stream of streams) {
      const setting = settings.get(stream.participantId) ?? DEFAULT_VOLUME_SETTING;
      stream.participant.setVolume(volumeToGain(setting), Track.Source.ScreenShareAudio);
    }
  }, [streams, settings]);

  // Output device: re-applied after every connect because the room's AudioContext is created then.
  useEffect(() => {
    if (connectionState !== 'connected') return;
    let active = true;
    room.switchActiveDevice('audiooutput', outputDeviceId ?? '').then(
      () => {
        if (active) setOutputError(null);
      },
      () => {
        if (!active) return;
        setOutputError(
          'Não foi possível usar o dispositivo de saída escolhido. Usando o padrão do sistema.',
        );
      },
    );
    return () => {
      active = false;
    };
  }, [room, connectionState, outputDeviceId]);

  const settingFor = useCallback(
    (participantId: string) => settings.get(participantId) ?? DEFAULT_VOLUME_SETTING,
    [settings],
  );

  const update = useCallback(
    (participantId: string, patch: (current: VolumeSetting) => VolumeSetting) => {
      setSettings((prev) => {
        const next = new Map(prev);
        next.set(participantId, patch(prev.get(participantId) ?? DEFAULT_VOLUME_SETTING));
        return next;
      });
    },
    [],
  );

  const setVolume = useCallback(
    (participantId: string, volume: number) => {
      const clamped = clampVolume(volume);
      // Dragging the slider above zero is an implicit unmute.
      update(participantId, (current) => ({
        volume: clamped,
        muted: clamped === 0 ? current.muted : false,
      }));
    },
    [update],
  );

  const setMuted = useCallback(
    (participantId: string, muted: boolean) => {
      update(participantId, (current) => ({ ...current, muted }));
    },
    [update],
  );

  const toggleMute = useCallback(
    (participantId: string) => {
      update(participantId, (current) => ({ ...current, muted: !current.muted }));
    },
    [update],
  );

  return { settingFor, setVolume, setMuted, toggleMute, outputError };
}
