/**
 * Jitter buffer between the PCM chunks pushed from the main process and the AudioWorklet's
 * fixed 128-frame render quantum. Planar storage, interleaved input. Pure TypeScript so it can run
 * both inside the worklet and under Vitest.
 *
 * - Output stays silent until `primeFrames` are buffered (absorbs IPC jitter), and goes back to
 *   priming after an underrun.
 * - When more than `capacityFrames` would be buffered the oldest frames are dropped, which caps
 *   the added latency at `capacityFrames / sampleRate`.
 */
export interface PcmJitterBufferOptions {
  channels: number;
  capacityFrames: number;
  primeFrames: number;
}

export class PcmJitterBuffer {
  readonly channels: number;
  readonly capacityFrames: number;
  readonly primeFrames: number;

  private readonly planes: Float32Array[];
  private readIndex = 0;
  private available = 0;
  private primed = false;
  private droppedFrames = 0;
  private underrunCount = 0;

  constructor(options: PcmJitterBufferOptions) {
    const { channels, capacityFrames, primeFrames } = options;
    if (!Number.isInteger(channels) || channels < 1) throw new RangeError('channels must be >= 1');
    if (!Number.isInteger(capacityFrames) || capacityFrames < 1) {
      throw new RangeError('capacityFrames must be >= 1');
    }
    if (!Number.isInteger(primeFrames) || primeFrames < 0 || primeFrames > capacityFrames) {
      throw new RangeError('primeFrames must be between 0 and capacityFrames');
    }
    this.channels = channels;
    this.capacityFrames = capacityFrames;
    this.primeFrames = primeFrames;
    this.planes = Array.from({ length: channels }, () => new Float32Array(capacityFrames));
  }

  get availableFrames(): number {
    return this.available;
  }

  /** Frames discarded because the buffer was full (latency cap) or a chunk was too large. */
  get dropped(): number {
    return this.droppedFrames;
  }

  /** Times `read` ran out of data after having been primed. */
  get underruns(): number {
    return this.underrunCount;
  }

  get isPrimed(): boolean {
    return this.primed;
  }

  /** Appends interleaved frames; trailing samples that do not form a full frame are ignored. */
  write(interleaved: Float32Array): void {
    const { channels, capacityFrames, planes } = this;
    let frames = Math.floor(interleaved.length / channels);
    if (frames === 0) return;

    let offset = 0;
    if (frames > capacityFrames) {
      // Keep only the newest frames; older ones would be dropped right away anyway.
      this.droppedFrames += frames - capacityFrames;
      offset = (frames - capacityFrames) * channels;
      frames = capacityFrames;
    }

    const overflow = this.available + frames - capacityFrames;
    if (overflow > 0) {
      this.readIndex = (this.readIndex + overflow) % capacityFrames;
      this.available -= overflow;
      this.droppedFrames += overflow;
    }

    let writeIndex = (this.readIndex + this.available) % capacityFrames;
    for (let frame = 0; frame < frames; frame += 1) {
      const base = offset + frame * channels;
      for (let channel = 0; channel < channels; channel += 1) {
        // Both indexes are bounded by construction.
        planes[channel]![writeIndex] = interleaved[base + channel]!;
      }
      writeIndex += 1;
      if (writeIndex === capacityFrames) writeIndex = 0;
    }
    this.available += frames;
    if (!this.primed && this.available >= this.primeFrames) this.primed = true;
  }

  /**
   * Fills every output channel (planar, all the same length). Missing frames become silence.
   * Returns true when at least one real frame was written.
   */
  read(outputs: Float32Array[]): boolean {
    const frames = outputs[0]?.length ?? 0;
    if (frames === 0) return false;

    const produced = this.primed ? Math.min(frames, this.available) : 0;
    const { capacityFrames, planes } = this;
    for (let channel = 0; channel < outputs.length; channel += 1) {
      const output = outputs[channel]!;
      // Mono sources feed every output channel; extra source channels are ignored.
      const plane = planes[Math.min(channel, planes.length - 1)]!;
      let index = this.readIndex;
      for (let frame = 0; frame < produced; frame += 1) {
        output[frame] = plane[index]!;
        index += 1;
        if (index === capacityFrames) index = 0;
      }
      output.fill(0, produced, frames);
    }

    this.readIndex = (this.readIndex + produced) % capacityFrames;
    this.available -= produced;
    if (this.primed && produced < frames) {
      this.underrunCount += 1;
      this.primed = false;
    }
    return produced > 0;
  }
}
