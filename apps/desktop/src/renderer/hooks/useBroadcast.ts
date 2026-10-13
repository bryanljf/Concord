import { useCallback, useEffect, useRef, useState } from 'react';
import type { QualityPresetId, RoomId } from '@concord/shared';
import {
  ConnectionState,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Room,
  type TrackPublishOptions,
} from 'livekit-client';
import type { StreamingState } from '../../preload/api';
import { createProcessAudioTrack, type ProcessAudioTrack } from '../audio/processAudioTrack';
import { displayMediaErrorMessage } from '../lib/capture';
import { concord, errorCode, toErrorMessage, type Settings } from '../lib/concord';
import { displayMediaConstraints, encodingParams, presetOf } from '../lib/encoding';
import { audioSwitchAction, planSourceSwitch } from '../lib/sourceSwitch';

/** How the broadcast carries audio (SPEC 5.7). */
export type BroadcastAudioMode = 'none' | 'system' | 'process';

export interface BroadcastRequest {
  room: RoomId;
  sourceId: string;
  sourceName: string;
  quality: QualityPresetId;
  audio: BroadcastAudioMode;
}

/** What the picker sends to switch the shared window/screen while live (same room). */
export type BroadcastSwitchRequest = Omit<BroadcastRequest, 'room'>;

export type BroadcastState =
  | { status: 'idle' }
  | { status: 'starting'; room: RoomId; sourceName: string }
  | {
      status: 'live';
      room: RoomId;
      /** desktopCapturer id of what is being shared (the picker marks it). */
      sourceId: string;
      sourceName: string;
      quality: QualityPresetId;
      /** Audio mode actually in use (after the process → loopback fallback). */
      audio: BroadcastAudioMode;
      /** Raw capture track, for the local preview tile. */
      videoTrack: MediaStreamTrack;
      hasAudio: boolean;
      startedAt: number;
    }
  | { status: 'stopping' };

export type BroadcastEndReason = 'user' | 'ended' | 'disconnected';

export interface Broadcast {
  state: BroadcastState;
  /** A source switch is in progress (the broadcast stays live meanwhile). */
  switching: boolean;
  /** Rejects with a pt-BR message; the hook already cleaned up. */
  start(request: BroadcastRequest): Promise<void>;
  /**
   * Swaps the shared window/screen while live, without stopping: the video publication keeps
   * its track SID (viewers keep their subscription). Rejects with a pt-BR message and keeps the
   * previous source live when the new one cannot be captured.
   */
  switchSource(request: BroadcastSwitchRequest): Promise<void>;
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
  roomId: RoomId;
  sourceId: string;
  quality: QualityPresetId;
  /** Detaches our 'ended' listener from `video` (the old track after a switch). */
  endedListener: AbortController;
}

type EncodingParams = ReturnType<typeof encodingParams>;

function audioPublishOptions(sourceName: string, params: EncodingParams): TrackPublishOptions {
  return {
    source: Track.Source.ScreenShareAudio,
    name: sourceName,
    dtx: false,
    red: false,
    forceStereo: true,
    audioPreset: params.audioPreset,
  };
}

function stopTrack(track: MediaStreamTrack | null): void {
  try {
    track?.stop();
  } catch {
    // Already stopped.
  }
}

/**
 * After a preset change, livekit recomputes the track's encodings on `replaceTrack` but skips
 * the simulcast layers that dynacast has paused (nobody watching that layer right now), and
 * re-enabling a layer later only flips `active`. So the new bitrate/fps caps are written to
 * every layer of the sender here. `encodings` is not part of livekit's public typings (it is
 * read defensively and this is a no-op when it is missing or does not match the sender).
 */
async function applyRecomputedEncodings(track: LocalVideoTrack): Promise<void> {
  const sender = track.sender;
  const target = (track as unknown as { encodings?: RTCRtpEncodingParameters[] }).encodings;
  if (!sender || !target) return;
  const params = sender.getParameters();
  if (params.encodings.length !== target.length) return;
  params.encodings.forEach((encoding, index) => {
    const next = target[index];
    if (next?.maxBitrate !== undefined) encoding.maxBitrate = next.maxBitrate;
    if (next?.maxFramerate !== undefined) encoding.maxFramerate = next.maxFramerate;
  });
  await sender.setParameters(params).catch(() => undefined);
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
      current.endedListener.abort();
      stopTrack(current.video);
      stopTrack(current.audio);
      await current.processAudio?.stop().catch(() => undefined);
    },
    [room],
  );

  /**
   * Per-process audio for `sourceId` when asked for, with the start() fallbacks: Discord closed
   * → system loopback, any other failure → no audio (both reported through onWarning).
   */
  const acquireProcessAudio = useCallback(
    async (
      requested: BroadcastAudioMode,
      sourceId: string,
    ): Promise<{ mode: BroadcastAudioMode; processAudio: ProcessAudioTrack | null }> => {
      if (requested !== 'process') return { mode: requested, processAudio: null };
      try {
        return { mode: 'process', processAudio: await createProcessAudioTrack(sourceId) };
      } catch (err) {
        if (errorCode(err) === DISCORD_NOT_RUNNING) {
          onWarningRef.current?.('Discord fechado: usando o áudio do sistema.', 'info');
          return { mode: 'system', processAudio: null };
        }
        onWarningRef.current?.(
          `${toErrorMessage(err, 'Áudio do aplicativo indisponível.')} Transmitindo sem som.`,
          'error',
        );
        return { mode: 'none', processAudio: null };
      }
    },
    [],
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
        const acquired = await acquireProcessAudio(request.audio, request.sourceId);
        const audioMode = acquired.mode;
        processAudio = acquired.processAudio;

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

        const endedListener = new AbortController();
        published.current = {
          video,
          audio,
          processAudio,
          roomId: request.room,
          sourceId: request.sourceId,
          quality: request.quality,
          endedListener,
        };
        video.addEventListener('ended', () => void finish('ended'), {
          once: true,
          signal: endedListener.signal,
        });

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
          await room.localParticipant.publishTrack(
            audio,
            audioPublishOptions(request.sourceName, params),
          );
        }

        setState({
          status: 'live',
          room: request.room,
          sourceId: request.sourceId,
          sourceName: request.sourceName,
          quality: request.quality,
          audio: audio === null ? 'none' : audioMode,
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
    [room, codec, join, finish, release, acquireProcessAudio],
  );

  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);

  /** Restarts the old source's per-process audio after a failed switch had stopped it. */
  const restoreProcessAudio = useCallback(
    async (previous: Published): Promise<void> => {
      const localAudio = room.localParticipant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      )?.audioTrack;
      try {
        const restored = await createProcessAudioTrack(previous.sourceId);
        if (localAudio) await localAudio.replaceTrack(restored.track, { userProvidedTrack: true });
        if (published.current === previous) {
          published.current = { ...previous, audio: restored.track, processAudio: restored };
        }
      } catch {
        if (localAudio) {
          await room.localParticipant.unpublishTrack(localAudio, false).catch(() => undefined);
        }
        if (published.current === previous) {
          published.current = { ...previous, audio: null, processAudio: null };
        }
        setState((state) =>
          state.status === 'live' ? { ...state, hasAudio: false, audio: 'none' } : state,
        );
        onWarningRef.current?.('O áudio do aplicativo parou. Transmitindo sem som.', 'error');
      }
    },
    [room],
  );

  const switchSource = useCallback(
    async (request: BroadcastSwitchRequest) => {
      const current = published.current;
      if (!current) throw new Error('Nenhuma transmissão ativa para trocar.');
      if (switchingRef.current) throw new Error('Já existe uma troca de fonte em andamento.');
      switchingRef.current = true;
      setSwitching(true);
      const plan = planSourceSwitch(
        { quality: current.quality, processAudio: current.processAudio !== null },
        { quality: request.quality, audio: request.audio },
      );
      const preset = presetOf(request.quality);
      const params = encodingParams(request.quality);
      let stream: MediaStream | null = null;
      let processAudio: ProcessAudioTrack | null = null;
      // Main runs one process capture at a time: the old one goes first when replaced by another.
      let oldProcessStopped = false;
      let videoSwapped = false;
      try {
        if (plan.stopOldProcessAudioFirst && current.processAudio) {
          await current.processAudio.stop().catch(() => undefined);
          oldProcessStopped = true;
        }
        const acquired = await acquireProcessAudio(request.audio, request.sourceId);
        const audioMode = acquired.mode;
        processAudio = acquired.processAudio;

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

        // Video: swapped inside the existing publication, so viewers keep their subscription.
        const localVideo = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShare,
        )?.videoTrack;
        if (!localVideo) throw new Error('A transmissão atual não foi encontrada.');
        if (plan.reencode) {
          // replaceTrack recomputes the sender encodings from publishOptions, but only when the
          // dimensions changed (hence the reset): the new preset's bitrate/fps apply in place.
          localVideo.publishOptions = {
            ...localVideo.publishOptions,
            screenShareEncoding: params.screenShareEncoding,
            degradationPreference: params.degradationPreference,
          };
          localVideo.lastEncodedDimensions = undefined;
          await localVideo
            .setDegradationPreference(params.degradationPreference)
            .catch(() => undefined);
        }
        await localVideo.replaceTrack(video, { userProvidedTrack: true });
        if (plan.reencode) await applyRecomputedEncodings(localVideo);
        videoSwapped = true;
        // Closing the OLD window must not end the broadcast anymore; closing the new one does.
        current.endedListener.abort();
        const endedListener = new AbortController();
        video.addEventListener('ended', () => void finish('ended'), {
          once: true,
          signal: endedListener.signal,
        });

        // Audio: replaced, published or unpublished depending on what each source carries. A
        // failure here is not fatal: the new video is already live.
        let publishedAudio: MediaStreamTrack | null = audio;
        const localAudio = room.localParticipant.getTrackPublication(
          Track.Source.ScreenShareAudio,
        )?.audioTrack;
        try {
          switch (audioSwitchAction(localAudio !== undefined, audio !== null)) {
            case 'replace':
              if (localAudio && audio) {
                await localAudio.replaceTrack(audio, { userProvidedTrack: true });
              }
              break;
            case 'publish':
              if (audio) {
                await room.localParticipant.publishTrack(
                  audio,
                  audioPublishOptions(request.sourceName, params),
                );
              }
              break;
            case 'unpublish':
              if (localAudio) await room.localParticipant.unpublishTrack(localAudio, false);
              break;
            case 'keep-none':
              break;
          }
        } catch {
          publishedAudio = null;
          const stale = room.localParticipant.getTrackPublication(
            Track.Source.ScreenShareAudio,
          )?.audioTrack;
          if (stale) {
            await room.localParticipant.unpublishTrack(stale, false).catch(() => undefined);
          }
          stopTrack(audio);
          onWarningRef.current?.('Não foi possível trocar o áudio. Transmitindo sem som.', 'error');
        }

        // The old capture is no longer published: release it.
        stopTrack(current.video);
        if (current.processAudio) {
          if (!oldProcessStopped) await current.processAudio.stop().catch(() => undefined);
        } else {
          stopTrack(current.audio);
        }
        if (!publishedAudio && processAudio) {
          await processAudio.stop().catch(() => undefined);
          processAudio = null;
        }

        published.current = {
          video,
          audio: publishedAudio,
          processAudio,
          roomId: current.roomId,
          sourceId: request.sourceId,
          quality: request.quality,
          endedListener,
        };
        setState((previous) =>
          previous.status === 'live'
            ? {
                ...previous,
                sourceId: request.sourceId,
                sourceName: request.sourceName,
                quality: request.quality,
                audio: publishedAudio === null ? 'none' : audioMode,
                videoTrack: video,
                hasAudio: publishedAudio !== null,
              }
            : previous,
        );
        reportStreamingState({
          active: true,
          room: current.roomId,
          sourceName: request.sourceName,
          quality: request.quality,
        });
      } catch (err) {
        if (!videoSwapped) {
          // Keep the previous source live: drop what was captured for the new one.
          for (const track of stream?.getTracks() ?? []) stopTrack(track);
          await processAudio?.stop().catch(() => undefined);
          if (oldProcessStopped) await restoreProcessAudio(current);
        }
        throw new Error(toErrorMessage(err, 'Não foi possível trocar a fonte.'), { cause: err });
      } finally {
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    [room, finish, acquireProcessAudio, restoreProcessAudio],
  );

  return { state, switching, start, switchSource, stop };
}
