/**
 * Turns the PCM pushed by main (`window.concord.onProcessAudioData`) into a MediaStreamTrack
 * that livekit-client can publish as `Track.Source.ScreenShareAudio` (SPEC 5.7, Phase 3b).
 *
 * Graph: main (Process Loopback, float32 interleaved) → IPC → AudioWorkletNode (jitter buffer,
 * `pcm-worklet.ts`) → MediaStreamAudioDestinationNode → `track`. Callers must check
 * `getProcessAudioSupport()` first and fall back to loopback when `startProcessAudio` rejects
 * (e.g. Discord not running for a screen capture).
 */
import type { ProcessAudioFormat } from '../../preload/api';
import workletUrl from './pcm-worklet?worker&url';
import { PCM_WORKLET_NAME, PCM_WORKLET_STOP, type PcmWorkletOptions } from './worklet-protocol';

export interface ProcessAudioTrack {
  track: MediaStreamTrack;
  /** Stops main's capture and releases the audio graph. */
  stop(): Promise<void>;
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

export async function createProcessAudioTrack(sourceId: string): Promise<ProcessAudioTrack> {
  const format: ProcessAudioFormat = await window.concord.startProcessAudio(sourceId);

  let context: AudioContext | null = null;
  let unsubscribe: () => void = () => undefined;
  const releaseMain = (): Promise<void> => window.concord.stopProcessAudio().catch(() => undefined);

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

    unsubscribe = window.concord.onProcessAudioData((chunk) => node.port.postMessage(chunk));
    if (audioContext.state !== 'running') await audioContext.resume();

    const track = destination.stream.getAudioTracks()[0];
    if (!track) throw new Error('Não foi possível criar a faixa de áudio da captura.');

    let stopped: Promise<void> | null = null;
    return {
      track,
      stop() {
        stopped ??= (async () => {
          unsubscribe();
          node.port.postMessage(PCM_WORKLET_STOP);
          node.disconnect();
          track.stop();
          await releaseMain();
          await audioContext.close().catch(() => undefined);
        })();
        return stopped;
      },
    };
  } catch (err) {
    unsubscribe();
    await releaseMain();
    if (context) await context.close().catch(() => undefined);
    throw err;
  }
}
