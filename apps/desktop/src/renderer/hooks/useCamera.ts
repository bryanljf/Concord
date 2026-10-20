import { useCallback, useEffect, useRef, useState } from 'react';
import type { RoomId } from '@concord/shared';
import {
  ConnectionState,
  RoomEvent,
  Track,
  VideoPresets,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Room,
  type TrackPublishOptions,
} from 'livekit-client';
import {
  CAMERA_ENCODING,
  cameraConstraints,
  cameraErrorMessage,
  cameraLabel,
} from '../lib/cameraEncoding';
import { toErrorMessage, type Settings } from '../lib/concord';

export type CameraState =
  | { status: 'off' }
  | { status: 'starting'; room: RoomId }
  | {
      status: 'on';
      room: RoomId;
      /** Requested device (null = system default). */
      deviceId: string | null;
      /** Device label shown in the UI ("Câmera" when unknown). */
      label: string;
      /** Raw capture track, for the local preview tile. */
      track: MediaStreamTrack;
      /** The published livekit track (stats, sender). */
      localTrack: LocalVideoTrack;
      startedAt: number;
    }
  | { status: 'stopping' };

/** Why the camera turned off without the user asking. */
export type CameraEndReason = 'ended' | 'disconnected';

export interface Camera {
  state: CameraState;
  /** A device switch is in progress (the camera stays on meanwhile). */
  switching: boolean;
  /**
   * Turns the webcam on in `room` (must be the room this window is connected to) and publishes
   * it as `Track.Source.Camera`. Rejects with a pt-BR message; the hook already cleaned up.
   */
  start(room: RoomId, deviceId: string | null): Promise<void>;
  /** Swaps the device while on, keeping the publication. Rejects with a pt-BR message. */
  switchDevice(deviceId: string | null): Promise<void>;
  stop(): Promise<void>;
}

export interface UseCameraOptions {
  room: Room;
  codec: Settings['codec'];
  /** Called when the camera turned off on its own (device unplugged, room lost). */
  onEnded?(reason: CameraEndReason): void;
}

interface Published {
  room: RoomId;
  deviceId: string | null;
  /** Current raw capture (changes on a device switch; the livekit track stays the same). */
  track: MediaStreamTrack;
  localTrack: LocalVideoTrack;
  /** Detaches our 'ended' listener from `track`. */
  endedListener: AbortController;
}

/** A start() in progress; `cancelled` says why it must be undone once its current await returns. */
interface Attempt {
  cancelled: 'user' | 'disconnected' | null;
}

/** `unpublished`: something else (server, livekit) removed the publication. */
type FinishReason = 'user' | 'ended' | 'disconnected' | 'unpublished';

/**
 * Two layers to spare CPU: 720p30 at 1.5 Mbps plus 320×180. With VP9/AV1 livekit uses SVC
 * instead and ignores the layer list. No backup codec: everyone runs the same Chromium.
 */
function publishOptions(codec: Settings['codec']): TrackPublishOptions {
  return {
    source: Track.Source.Camera,
    name: 'camera',
    simulcast: true,
    backupCodec: false,
    videoCodec: codec,
    videoEncoding: CAMERA_ENCODING,
    videoSimulcastLayers: [VideoPresets.h180],
  };
}

/** Read through a call: TypeScript would keep `room.state` narrowed across awaits. */
function isDisconnected(room: Room): boolean {
  return room.state === ConnectionState.Disconnected;
}

function stopTrack(track: MediaStreamTrack | null): void {
  try {
    track?.stop();
  } catch {
    // Already stopped.
  }
}

/** Opens the webcam; rejects with a pt-BR message. */
async function captureCamera(deviceId: string | null): Promise<MediaStreamTrack> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(cameraConstraints(deviceId));
  } catch (err) {
    throw new Error(cameraErrorMessage(err), { cause: err });
  }
  const track = stream.getVideoTracks()[0] ?? null;
  for (const other of stream.getTracks()) if (other !== track) stopTrack(other);
  if (!track) throw new Error('A câmera não retornou vídeo.');
  return track;
}

/**
 * Publishes the webcam as `Track.Source.Camera`. livekit only mutes a user-provided track whose
 * device went away, so the hook unpublishes it itself (and tells the owner through `onEnded`),
 * as it does when the room disconnects. A device switch replaces the track inside the same
 * publication, so viewers keep their subscription.
 */
export function useCamera(options: UseCameraOptions): Camera {
  const { room, codec, onEnded } = options;
  const [state, setState] = useState<CameraState>({ status: 'off' });
  const [switching, setSwitching] = useState(false);
  const published = useRef<Published | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const switchingRef = useRef(false);
  const onEndedRef = useRef(onEnded);
  useEffect(() => {
    onEndedRef.current = onEnded;
  }, [onEnded]);

  const release = useCallback(
    async (current: Published, unpublish: boolean) => {
      current.endedListener.abort();
      if (unpublish && !isDisconnected(room)) {
        await room.localParticipant.unpublishTrack(current.localTrack, true).catch(() => undefined);
      }
      stopTrack(current.track);
    },
    [room],
  );

  const finish = useCallback(
    async (reason: FinishReason) => {
      const current = published.current;
      if (!current) return;
      published.current = null;
      setState({ status: 'stopping' });
      // Disconnected / unpublished: livekit already removed the publication.
      await release(current, reason === 'user' || reason === 'ended');
      setState({ status: 'off' });
      if (reason === 'disconnected') onEndedRef.current?.('disconnected');
      else if (reason !== 'user') onEndedRef.current?.('ended');
    },
    [release],
  );

  /** Follows the raw track: an unplugged camera ends it (stop() never fires 'ended'). */
  const watchEnded = useCallback(
    (track: MediaStreamTrack): AbortController => {
      const controller = new AbortController();
      track.addEventListener('ended', () => void finish('ended'), {
        once: true,
        signal: controller.signal,
      });
      return controller;
    },
    [finish],
  );

  useEffect(() => {
    const onUnpublished = (publication: LocalTrackPublication): void => {
      const current = published.current;
      if (!current || publication.source !== Track.Source.Camera) return;
      if (publication.track && publication.track !== current.localTrack) return;
      // A full reconnect unpublishes and republishes every track by itself.
      if (
        room.state === ConnectionState.Reconnecting ||
        room.state === ConnectionState.SignalReconnecting
      ) {
        return;
      }
      // Room.disconnect() unpublishes every track right before emitting `Disconnected`: let that
      // event (same tick) name the reason first.
      queueMicrotask(() => {
        if (published.current === current) void finish('unpublished');
      });
    };
    const onReconnected = (): void => {
      const current = published.current;
      if (!current) return;
      const republished = room.localParticipant.getTrackPublication(Track.Source.Camera);
      if (republished?.track !== current.localTrack) void finish('unpublished');
    };
    const onDisconnected = (): void => {
      if (attempt.current) attempt.current.cancelled = 'disconnected';
      if (published.current) void finish('disconnected');
    };
    room.on(RoomEvent.LocalTrackUnpublished, onUnpublished);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.Disconnected, onDisconnected);
    return () => {
      room.off(RoomEvent.LocalTrackUnpublished, onUnpublished);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.Disconnected, onDisconnected);
    };
  }, [room, finish]);

  // Turn the camera off if the owner unmounts while it is on (or starting).
  useEffect(
    () => () => {
      if (attempt.current) attempt.current.cancelled = 'user';
      const current = published.current;
      published.current = null;
      if (current) void release(current, true);
    },
    [release],
  );

  const start = useCallback(
    async (roomId: RoomId, deviceId: string | null) => {
      if (published.current || attempt.current) throw new Error('A câmera já está ligada.');
      if (room.state !== ConnectionState.Connected) {
        throw new Error('Entre numa sala para ligar a câmera.');
      }
      const current: Attempt = { cancelled: null };
      attempt.current = current;
      setState({ status: 'starting', room: roomId });
      let track: MediaStreamTrack | null = null;
      let publishing = false;
      let localTrack: LocalVideoTrack | undefined;
      try {
        track = await captureCamera(deviceId);
        if (current.cancelled) throw new Error('cancelled');
        publishing = true;
        try {
          const publication = await room.localParticipant.publishTrack(
            track,
            publishOptions(codec),
          );
          localTrack = publication.videoTrack;
        } catch (err) {
          throw new Error('Não foi possível publicar a câmera na sala.', { cause: err });
        }
        if (!localTrack) throw new Error('Não foi possível publicar a câmera na sala.');
        if (current.cancelled) throw new Error('cancelled');

        published.current = {
          room: roomId,
          deviceId,
          track,
          localTrack,
          endedListener: watchEnded(track),
        };
        setState({
          status: 'on',
          room: roomId,
          deviceId,
          label: cameraLabel(track.label),
          track,
          localTrack,
          startedAt: Date.now(),
        });
      } catch (err) {
        if (publishing && !isDisconnected(room)) {
          const leftover = localTrack ?? track;
          if (leftover) {
            await room.localParticipant.unpublishTrack(leftover, true).catch(() => undefined);
          }
        }
        stopTrack(track);
        setState({ status: 'off' });
        // Turned off (or the window closed) while starting: nothing to report.
        if (current.cancelled === 'user') return;
        if (current.cancelled === 'disconnected') {
          throw new Error('A conexão com a sala caiu antes de a câmera ligar.', { cause: err });
        }
        throw new Error(toErrorMessage(err, 'Não foi possível ligar a câmera.'), { cause: err });
      } finally {
        if (attempt.current === current) attempt.current = null;
      }
    },
    [room, codec, watchEnded],
  );

  const switchDevice = useCallback(
    async (deviceId: string | null) => {
      const current = published.current;
      if (!current) throw new Error('A câmera não está ligada.');
      if (switchingRef.current) throw new Error('Já existe uma troca de câmera em andamento.');
      switchingRef.current = true;
      setSwitching(true);
      try {
        const track = await captureCamera(deviceId);
        if (published.current !== current) {
          // Turned off meanwhile.
          stopTrack(track);
          return;
        }
        let replaceError: unknown = null;
        await current.localTrack
          .replaceTrack(track, { userProvidedTrack: true })
          .catch((err: unknown) => {
            replaceError = err;
          });
        // What counts is whether the sender now carries the new capture.
        const swapped = current.localTrack.mediaStreamTrack === track;
        if (!swapped || published.current !== current) {
          stopTrack(track);
          if (published.current !== current) return;
          throw new Error('Não foi possível trocar a câmera.', { cause: replaceError });
        }
        // livekit does not stop the capture it replaced.
        current.endedListener.abort();
        stopTrack(current.track);
        published.current = { ...current, deviceId, track, endedListener: watchEnded(track) };
        setState((previous) =>
          previous.status === 'on'
            ? { ...previous, deviceId, label: cameraLabel(track.label), track }
            : previous,
        );
      } catch (err) {
        throw new Error(toErrorMessage(err, 'Não foi possível trocar a câmera.'), { cause: err });
      } finally {
        switchingRef.current = false;
        setSwitching(false);
      }
    },
    [watchEnded],
  );

  const stop = useCallback(async () => {
    if (attempt.current) attempt.current.cancelled = 'user';
    await finish('user');
  }, [finish]);

  return { state, switching, start, switchDevice, stop };
}
