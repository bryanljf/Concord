import { useCallback, useEffect, useRef, useState } from 'react';
import type { QualityPresetId, RoomId } from '@concord/shared';
import {
  ConnectionState,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type Room,
  type TrackPublishOptions,
} from 'livekit-client';
import type { StreamingState } from '../../preload/api';
import { createProcessAudioTrack, type ProcessAudioTrack } from '../audio/processAudioTrack';
import { displayMediaErrorMessage } from '../lib/capture';
import { concord, errorCode, toErrorMessage, type Settings } from '../lib/concord';
import { displayMediaConstraints, encodingParams, presetOf } from '../lib/encoding';

/** How the broadcast carries audio (SPEC 5.7). */
export type BroadcastAudioMode = 'none' | 'system' | 'process';

export interface BroadcastRequest {
  room: RoomId;
  sourceId: string;
  sourceName: string;
  quality: QualityPresetId;
  audio: BroadcastAudioMode;
}

export type BroadcastState =
  | { status: 'idle' }
  | { status: 'starting'; room: RoomId; sourceName: string }
  | {
      status: 'live';
      room: RoomId;
      sourceName: string;
      quality: QualityPresetId;
      /** Raw capture track, for the local preview tile. */
      videoTrack: MediaStreamTrack;
      hasAudio: boolean;
      startedAt: number;
    }
  | { status: 'stopping' };

export type BroadcastEndReason = 'user' | 'ended' | 'disconnected';

export interface Broadcast {
  state: BroadcastState;
  /** Rejects with a pt-BR message; the hook already cleaned up. */
  start(request: BroadcastRequest): Promise<void>;
  stop(): Promise<void>;
}

interface UseBroadcastOptions {
  room: Room;
  currentRoom: RoomId | null;
  codec: Settings['codec'];
  /** `useRoom().join`: resolves true once connected. */
  join(roomId: RoomId): Promise<boolean>;
  /** Called when the broadcast ended on its own (window closed, room disconnected). */
  onEnded?(reason: BroadcastEndReason): void;
  /** Non-fatal notices while starting (audio fell back to loopback, audio unavailable, …). */
  onWarning?(message: string, tone: 'info' | 'error'): void;
}

/** Main rejects `startProcessAudio` with this code for a screen capture while Discord is closed. */
const DISCORD_NOT_RUNNING = 'discord_not_running';

const INACTIVE: StreamingState = { active: false, room: null, sourceName: null, quality: null };

interface Published {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  processAudio: ProcessAudioTrack | null;
}

function stopTrack(track: MediaStreamTrack | null): void {
  try {
    track?.stop();
  } catch {
    // Already stopped.
  }
}

/** Mirrors the renderer's streaming state to main (tray icon, tooltip, pop-outs). */
function reportStreamingState(state: StreamingState): void {
  concord()
    .setStreamingState(state)
    .catch(() => {
      // Main may not expose the handler yet; the UI state is still correct.
    });
}

/**
 * Publishes a window/screen capture (SPEC 5.6): the main process answers `getDisplayMedia`
 * with the source chosen in the picker, the video goes out as `Track.Source.ScreenShare` with
 * simulcast and the preset's encoding, and the audio (system loopback or per-process capture)
 * as `Track.Source.ScreenShareAudio` at 128 kbps without DTX/RED.
 */
export function useBroadcast(options: UseBroadcastOptions): Broadcast {
  const { room, currentRoom, codec, join, onEnded, onWarning } = options;
  const [state, setState] = useState<BroadcastState>({ status: 'idle' });
  const published = useRef<Published | null>(null);
  // Latest props, readable from long-running async work without re-creating callbacks.
  const currentRoomRef = useRef(currentRoom);
  const onEndedRef = useRef(onEnded);
  const onWarningRef = useRef(onWarning);
  useEffect(() => {
    currentRoomRef.current = currentRoom;
    onEndedRef.current = onEnded;
    onWarningRef.current = onWarning;
  }, [currentRoom, onEnded, onWarning]);

  // A fresh renderer never streams: tell main so a stale "ao vivo" tray state is cleared.
  useEffect(() => reportStreamingState(INACTIVE), []);

  const release = useCallback(
    async (unpublish: boolean) => {
      const current = published.current;
      published.current = null;
      if (!current) return;
      if (unpublish && room.state !== ConnectionState.Disconnected) {
        const tracks = [current.video, current.audio].filter(
          (track): track is MediaStreamTrack => track !== null,
        );
        await Promise.all(
          tracks.map((track) =>
            room.localParticipant.unpublishTrack(track, true).catch(() => undefined),
          ),
        );
      }
      stopTrack(current.video);
      stopTrack(current.audio);
      await current.processAudio?.stop().catch(() => undefined);
    },
    [room],
  );

  const finish = useCallback(
    async (reason: BroadcastEndReason) => {
      if (!published.current) return;
      setState({ status: 'stopping' });
      await release(reason !== 'disconnected');
      setState({ status: 'idle' });
      reportStreamingState(INACTIVE);
      if (reason !== 'user') onEndedRef.current?.(reason);
    },
    [release],
  );

  const stop = useCallback(() => finish('user'), [finish]);

  // livekit unpublishes screen-share tracks by itself when the capture ends; follow it.
  useEffect(() => {
    const onUnpublished = (publication: LocalTrackPublication): void => {
      const current = published.current;
      if (!current || publication.source !== Track.Source.ScreenShare) return;
      void finish('ended');
    };
    const onDisconnected = (): void => {
      if (published.current) void finish('disconnected');
    };
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, finish]);

  // Stop everything if the owner unmounts mid-broadcast.
  useEffect(
    () => () => {
      void release(true);
    },
    [release],
  );

  const start = useCallback(
    async (request: BroadcastRequest) => {
      if (published.current) throw new Error('Já existe uma transmissão em andamento.');
      setState({ status: 'starting', room: request.room, sourceName: request.sourceName });
      const preset = presetOf(request.quality);
      const params = encodingParams(request.quality);
      let stream: MediaStream | null = null;
      let processAudio: ProcessAudioTrack | null = null;
      try {
        const inRoom =
          currentRoomRef.current === request.room && room.state === ConnectionState.Connected;
        if (!inRoom) {
          const connected = await join(request.room);
          if (!connected) throw new Error('Não foi possível entrar na sala para transmitir.');
        }

        // Per-process audio is started first: whether it works decides if the display-media
        // request must carry Electron's loopback audio instead (SPEC 5.7).
        let audioMode: BroadcastAudioMode = request.audio;
        if (audioMode === 'process') {
          try {
            processAudio = await createProcessAudioTrack(request.sourceId);
          } catch (err) {
            processAudio = null;
            if (errorCode(err) === DISCORD_NOT_RUNNING) {
              audioMode = 'system';
              onWarningRef.current?.('Discord fechado: usando o áudio do sistema.', 'info');
            } else {
              audioMode = 'none';
              onWarningRef.current?.(
                `${toErrorMessage(err, 'Áudio do aplicativo indisponível.')} Transmitindo sem som.`,
                'error',
              );
            }
          }
        }

        await concord().selectCaptureSource({
          sourceId: request.sourceId,
          systemAudio: audioMode === 'system',
        });
        try {
          stream = await navigator.mediaDevices.getDisplayMedia(
            displayMediaConstraints(preset, audioMode === 'system'),
          );
        } catch (err) {
          throw new Error(displayMediaErrorMessage(err), { cause: err });
        }
        const video = stream.getVideoTracks()[0];
        if (!video) throw new Error('A captura não retornou vídeo.');
        video.contentHint = params.contentHint;

        let audio: MediaStreamTrack | null = null;
        if (audioMode === 'system') {
          audio = stream.getAudioTracks()[0] ?? null;
          if (!audio) {
            onWarningRef.current?.(
              'O áudio do sistema não veio na captura. Transmitindo sem som.',
              'error',
            );
          }
        } else if (processAudio) {
          audio = processAudio.track;
        }

        published.current = { video, audio, processAudio };
        video.addEventListener('ended', () => void finish('ended'), { once: true });

        const videoOptions: TrackPublishOptions = {
          source: Track.Source.ScreenShare,
          name: request.sourceName,
          simulcast: true,
          videoCodec: codec,
          screenShareEncoding: params.screenShareEncoding,
          degradationPreference: params.degradationPreference,
        };
        await room.localParticipant.publishTrack(video, videoOptions);
        if (audio) {
          const audioOptions: TrackPublishOptions = {
            source: Track.Source.ScreenShareAudio,
            name: request.sourceName,
            dtx: false,
            red: false,
            forceStereo: true,
            audioPreset: params.audioPreset,
          };
          await room.localParticipant.publishTrack(audio, audioOptions);
        }

        setState({
          status: 'live',
          room: request.room,
          sourceName: request.sourceName,
          quality: request.quality,
          videoTrack: video,
          hasAudio: audio !== null,
          startedAt: Date.now(),
        });
        reportStreamingState({
          active: true,
          room: request.room,
          sourceName: request.sourceName,
          quality: request.quality,
        });
      } catch (err) {
        if (published.current) {
          await release(true);
        } else {
          for (const track of stream?.getTracks() ?? []) stopTrack(track);
          await processAudio?.stop().catch(() => undefined);
        }
        setState({ status: 'idle' });
        reportStreamingState(INACTIVE);
        throw new Error(toErrorMessage(err, 'Não foi possível iniciar a transmissão.'), {
          cause: err,
        });
      }
    },
    [room, codec, join, finish, release],
  );

  return { state, start, stop };
}
