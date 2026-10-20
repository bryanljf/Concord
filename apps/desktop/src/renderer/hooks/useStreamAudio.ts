import { useCallback, useEffect, useRef, useState } from 'react';
import { Track, type RemoteAudioTrack, type Room } from 'livekit-client';
import {
  DEFAULT_VOLUME_SETTING,
  clampVolume,
  normalizeVolumeSetting,
  toggleMuteSetting,
  volumeToGain,
  type VolumeSetting,
} from '../lib/volume';
import type { RoomConnectionState } from './useRoom';
import type { RemoteStream } from './useRemoteStreams';

export interface StreamAudio {
  /**
   * Current setting for a participant (defaults to 50 %, unmuted; 100 % at most), shown muted
   * while the grid silences it.
   */
  settingFor(participantId: string): VolumeSetting;
  setVolume(participantId: string, volume: number): void;
  setMuted(participantId: string, muted: boolean): void;
  toggleMute(participantId: string): void;
  /** pt-BR message when the chosen output device could not be used (null when fine). */
  outputError: string | null;
}

const NONE: ReadonlySet<string> = new Set();

interface UseStreamAudioOptions {
  room: Room;
  connectionState: RoomConnectionState;
  streams: readonly RemoteStream[];
  /** `Settings.audioOutputDeviceId`; null = system default. */
  outputDeviceId: string | null;
  /**
   * Participants whose screen-share audio the grid keeps silent (`lib/gridAudio.ts`): played at
   * zero gain without touching their remembered setting.
   */
  silenced?: ReadonlySet<string>;
  /** Turning a silenced participant up (volume above zero, unmute) calls this to lift it. */
  onUnsilence?(participantId: string): void;
}

/**
 * Playback side: every subscribed screen-share audio track is attached (the
 * room's Web Audio mix routes it through a GainNode), per-participant volume/mute is remembered
 * for the session and re-applied on every (re)subscription, and the output device follows the
 * settings via `Room.switchActiveDevice('audiooutput')` (AudioContext.setSinkId + <audio>.setSinkId).
 */
export function useStreamAudio(options: UseStreamAudioOptions): StreamAudio {
  const { room, connectionState, streams, outputDeviceId, silenced = NONE, onUnsilence } = options;
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
      const gain = silenced.has(stream.participantId) ? 0 : volumeToGain(setting);
      stream.participant.setVolume(gain, Track.Source.ScreenShareAudio);
    }
  }, [streams, settings, silenced]);

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

  // Remembered values above 100 % (from the old 0–200 % range) are clamped on the way out.
  const settingFor = useCallback(
    (participantId: string) => {
      const setting = normalizeVolumeSetting(settings.get(participantId) ?? DEFAULT_VOLUME_SETTING);
      return silenced.has(participantId) ? { ...setting, muted: true } : setting;
    },
    [settings, silenced],
  );

  /** Lifts the grid's silence; true when the participant was silenced. */
  const unsilence = useCallback(
    (participantId: string): boolean => {
      if (!silenced.has(participantId)) return false;
      onUnsilence?.(participantId);
      return true;
    },
    [silenced, onUnsilence],
  );

  const update = useCallback(
    (participantId: string, patch: (current: VolumeSetting) => VolumeSetting) => {
      setSettings((prev) => {
        const next = new Map(prev);
        const current = normalizeVolumeSetting(prev.get(participantId) ?? DEFAULT_VOLUME_SETTING);
        next.set(participantId, patch(current));
        return next;
      });
    },
    [],
  );

  const setVolume = useCallback(
    (participantId: string, volume: number) => {
      const clamped = clampVolume(volume);
      // Dragging the slider above zero is an implicit unmute, also of the grid's silence.
      if (clamped > 0) unsilence(participantId);
      update(participantId, (current) => ({
        volume: clamped,
        muted: clamped === 0 ? current.muted : false,
      }));
    },
    [update, unsilence],
  );

  const setMuted = useCallback(
    (participantId: string, muted: boolean) => {
      if (!muted) unsilence(participantId);
      update(participantId, (current) => ({ ...current, muted }));
    },
    [update, unsilence],
  );

  const toggleMute = useCallback(
    (participantId: string) => {
      // A silenced stream shows as muted: the toggle makes it heard.
      if (unsilence(participantId)) {
        update(participantId, (current) => ({ ...current, muted: false }));
        return;
      }
      update(participantId, toggleMuteSetting);
    },
    [update, unsilence],
  );

  return { settingFor, setVolume, setMuted, toggleMute, outputError };
}
