/**
 * AudioWorklet processor that turns the PCM chunks posted through its port into a continuous
 * audio output (silence when nothing arrives). Bundled by Vite through `?worker&url` and loaded
 * with `audioWorklet.addModule()`; it runs in the AudioWorkletGlobalScope, never in the window.
 */
import { PcmJitterBuffer } from './ringBuffer';
import { PCM_WORKLET_NAME, PCM_WORKLET_STOP, type PcmWorkletOptions } from './worklet-protocol';

// lib.dom does not describe the AudioWorkletGlobalScope; declare the two globals used here.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

const DEFAULTS: PcmWorkletOptions = { channels: 2, capacityFrames: 4800, primeFrames: 1440 };

class PcmSourceProcessor extends AudioWorkletProcessor {
  private readonly buffer: PcmJitterBuffer;
  private stopped = false;

  constructor(options: AudioWorkletNodeOptions) {
    super();
    const config = { ...DEFAULTS, ...(options.processorOptions as Partial<PcmWorkletOptions>) };
    this.buffer = new PcmJitterBuffer(config);
    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (data === PCM_WORKLET_STOP) {
        this.stopped = true;
      } else if (data instanceof Float32Array) {
        this.buffer.write(data);
      }
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (output && output.length > 0) this.buffer.read(output);
    return !this.stopped;
  }
}

registerProcessor(PCM_WORKLET_NAME, PcmSourceProcessor);
