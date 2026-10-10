/**
 * Turns the PCM pushed by main (`window.concord.onProcessAudioData`) into a MediaStreamTrack
 * that livekit-client can publish as `Track.Source.ScreenShareAudio` (SPEC 5.7, Phase 3b).
 * The real implementation (AudioWorklet → MediaStreamAudioDestinationNode) lands with Phase 3b;
 * until then callers must check `getProcessAudioSupport()` first and fall back to loopback.
 */
import type { ProcessAudioFormat } from '../../preload/api';

export interface ProcessAudioTrack {
  track: MediaStreamTrack;
  /** Stops main's capture and releases the audio graph. */
  stop(): Promise<void>;
}

export async function createProcessAudioTrack(sourceId: string): Promise<ProcessAudioTrack> {
  const format: ProcessAudioFormat = await window.concord.startProcessAudio(sourceId);
  await window.concord.stopProcessAudio();
  throw new Error(
    `Captura de áudio por processo ainda não disponível (${format.channels} canais a ${format.sampleRate} Hz).`,
  );
}
