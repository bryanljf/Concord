/**
 * Shared between the renderer (`processAudioTrack.ts`) and the AudioWorklet (`pcm-worklet.ts`).
 * Kept apart from the worklet module itself, which must never be imported into the window
 * context (it calls `registerProcessor` at load time).
 */
export const PCM_WORKLET_NAME = 'concord-pcm-source';

/** `processorOptions` passed to the AudioWorkletNode. */
export interface PcmWorkletOptions {
  channels: number;
  capacityFrames: number;
  primeFrames: number;
}

/** Message that makes the processor return false from `process()` so the node is released. */
export const PCM_WORKLET_STOP = 'stop';
