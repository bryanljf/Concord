/**
 * Turns the PCM pushed by main (`window.concord.onProcessAudioData`) into a MediaStreamTrack
 * that livekit-client can publish: the screen share's `Track.Source.ScreenShareAudio`, or the
 * separate music track (Phase 3b). Several can run at once; each only takes the chunks tagged
 * with its own `captureId`.
 *
 * Graph: main (Process Loopback, float32 interleaved) → IPC → AudioWorkletNode (jitter buffer,
 * `pcm-worklet.ts`) → MediaStreamAudioDestinationNode → `track`. Callers must check
 * `getProcessAudioSupport()` first and fall back to loopback when `startProcessAudio` rejects
 * (e.g. Discord not running for a screen capture, or `app_not_running` for a music app).
 */
import type { ProcessAudioFormat, ProcessAudioTarget } from '../../preload/api';
import workletUrl from './pcm-worklet?worker&url';
import { PCM_WORKLET_NAME, PCM_WORKLET_STOP, type PcmWorkletOptions } from './worklet-protocol';

export interface ProcessAudioTrack {
  track: MediaStreamTrack;
  /** Main's capture id (tags the PCM chunks). */
  captureId: string;
  /** Stops main's capture and releases the audio graph. */
  stop(): Promise<void>;
  /**
   * Called once when main ended the capture on its own (the captured app was closed); the
   * graph is already released by then.
   */
  onEnded(listener: () => void): void;
}

/** Upper bound for audio buffered in the renderer; older frames are dropped beyond it. */
export const MAX_BUFFERED_MS = 100;
/** Audio accumulated before playback (re)starts, to ride out IPC jitter. */
export const PRIME_MS = 30;

export function workletOptions(format: ProcessAudioFormat): PcmWorkletOptions {
  const frames = (ms: number): number => Math.max(1, Math.round((format.sampleRate * ms) / 1000));
  return {
    channels: format.channels,
    capacityFrames: frames(MAX_BUFFERED_MS),
    primeFrames: frames(PRIME_MS),
  };
}

export async function createProcessAudioTrack(
  target: ProcessAudioTarget,
): Promise<ProcessAudioTrack> {
  const { captureId, format } = await window.concord.startProcessAudio(target);

  let context: AudioContext | null = null;
  const unsubscribers: (() => void)[] = [];
  const unsubscribe = (): void => {
    for (const off of unsubscribers.splice(0)) off();
  };
  const releaseMain = (): Promise<void> =>
    window.concord.stopProcessAudio(captureId).catch(() => undefined);

  try {
    const audioContext = new AudioContext({
      sampleRate: format.sampleRate,
      latencyHint: 'interactive',
    });
    context = audioContext;
    await audioContext.audioWorklet.addModule(workletUrl);

    const node = new AudioWorkletNode(audioContext, PCM_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [format.channels],
      processorOptions: workletOptions(format),
    });
    const destination = audioContext.createMediaStreamDestination();
    node.connect(destination);

    unsubscribers.push(
      window.concord.onProcessAudioData((id, chunk) => {
        if (id === captureId) node.port.postMessage(chunk);
      }),
    );
    if (audioContext.state !== 'running') await audioContext.resume();

    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('Não foi possível criar a faixa de áudio da captura.');

    let stopped: Promise<void> | null = null;
    const release = (stopMain: boolean): Promise<void> => {
      stopped ??= (async () => {
        unsubscribe();
        node.port.postMessage(PCM_WORKLET_STOP);
        node.disconnect();
        track.stop();
        if (stopMain) await releaseMain();
        await audioContext.close().catch(() => undefined);
      })();
      return stopped;
    };

    const endedListeners: (() => void)[] = [];
    unsubscribers.push(
      window.concord.onProcessAudioEnded((id) => {
        if (id !== captureId) return;
        void release(false).then(() => {
          for (const listener of endedListeners.splice(0)) listener();
        });
      }),
    );

    return {
      track,
      captureId,
      stop: () => release(true),
      onEnded(listener) {
        endedListeners.push(listener);
      },
    };
  } catch (err) {
    unsubscribe();
    await releaseMain();
    if (context) await context.close().catch(() => undefined);
    throw err;
  }
}
