import { describe, expect, it } from 'vitest';
import { PcmJitterBuffer } from './ringBuffer';

function interleave(left: number[], right: number[]): Float32Array {
  const out = new Float32Array(left.length * 2);
  left.forEach((value, index) => {
    out[index * 2] = value;
    out[index * 2 + 1] = right[index] ?? 0;
  });
  return out;
}

function outputs(channels: number, frames: number): Float32Array[] {
  return Array.from({ length: channels }, () => new Float32Array(frames));
}

describe('PcmJitterBuffer', () => {
  it('validates its options', () => {
    expect(() => new PcmJitterBuffer({ channels: 0, capacityFrames: 8, primeFrames: 0 })).toThrow(
      RangeError,
    );
    expect(() => new PcmJitterBuffer({ channels: 2, capacityFrames: 0, primeFrames: 0 })).toThrow(
      RangeError,
    );
    expect(() => new PcmJitterBuffer({ channels: 2, capacityFrames: 8, primeFrames: 9 })).toThrow(
      RangeError,
    );
  });

  it('de-interleaves into planar outputs', () => {
    const buffer = new PcmJitterBuffer({ channels: 2, capacityFrames: 16, primeFrames: 0 });
    buffer.write(interleave([1, 2, 3], [-1, -2, -3]));
    const out = outputs(2, 3);
    expect(buffer.read(out)).toBe(true);
    expect(Array.from(out[0] ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(out[1] ?? [])).toEqual([-1, -2, -3]);
    expect(buffer.availableFrames).toBe(0);
  });

  it('stays silent until primed, then plays', () => {
    const buffer = new PcmJitterBuffer({ channels: 2, capacityFrames: 16, primeFrames: 4 });
    buffer.write(interleave([1, 2], [1, 2]));
    const silent = outputs(2, 2);
    expect(buffer.read(silent)).toBe(false);
    expect(Array.from(silent[0] ?? [])).toEqual([0, 0]);
    expect(buffer.availableFrames).toBe(2);
    buffer.write(interleave([3, 4], [3, 4]));
    expect(buffer.isPrimed).toBe(true);
    const playing = outputs(2, 4);
    expect(buffer.read(playing)).toBe(true);
    expect(Array.from(playing[0] ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('pads underruns with silence and re-primes', () => {
    const buffer = new PcmJitterBuffer({ channels: 1, capacityFrames: 8, primeFrames: 2 });
    buffer.write(new Float32Array([1, 2, 3]));
    const out = outputs(1, 4);
    expect(buffer.read(out)).toBe(true);
    expect(Array.from(out[0] ?? [])).toEqual([1, 2, 3, 0]);
    expect(buffer.underruns).toBe(1);
    expect(buffer.isPrimed).toBe(false);
    buffer.write(new Float32Array([4]));
    expect(buffer.read(outputs(1, 1))).toBe(false);
    buffer.write(new Float32Array([5]));
    const resumed = outputs(1, 2);
    expect(buffer.read(resumed)).toBe(true);
    expect(Array.from(resumed[0] ?? [])).toEqual([4, 5]);
  });

  it('drops the oldest frames when the latency cap is exceeded', () => {
    const buffer = new PcmJitterBuffer({ channels: 1, capacityFrames: 4, primeFrames: 0 });
    buffer.write(new Float32Array([1, 2, 3]));
    buffer.write(new Float32Array([4, 5]));
    expect(buffer.dropped).toBe(1);
    expect(buffer.availableFrames).toBe(4);
    const out = outputs(1, 4);
    buffer.read(out);
    expect(Array.from(out[0] ?? [])).toEqual([2, 3, 4, 5]);
  });

  it('keeps only the newest frames of a chunk larger than the capacity', () => {
    const buffer = new PcmJitterBuffer({ channels: 1, capacityFrames: 3, primeFrames: 0 });
    buffer.write(new Float32Array([1, 2, 3, 4, 5]));
    expect(buffer.dropped).toBe(2);
    const out = outputs(1, 3);
    buffer.read(out);
    expect(Array.from(out[0] ?? [])).toEqual([3, 4, 5]);
  });

  it('wraps around the ring correctly', () => {
    const buffer = new PcmJitterBuffer({ channels: 1, capacityFrames: 4, primeFrames: 0 });
    const played: number[] = [];
    for (let value = 1; value <= 20; value += 1) {
      buffer.write(new Float32Array([value]));
      if (value % 3 === 0) {
        const out = outputs(1, 3);
        buffer.read(out);
        played.push(...Array.from(out[0] ?? []));
      }
    }
    expect(played).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
  });

  it('ignores trailing partial frames and empty reads', () => {
    const buffer = new PcmJitterBuffer({ channels: 2, capacityFrames: 8, primeFrames: 0 });
    buffer.write(new Float32Array([1, 1, 2]));
    expect(buffer.availableFrames).toBe(1);
    expect(buffer.read([])).toBe(false);
    expect(buffer.read(outputs(2, 0))).toBe(false);
  });

  it('duplicates a mono source to every output channel', () => {
    const buffer = new PcmJitterBuffer({ channels: 1, capacityFrames: 8, primeFrames: 0 });
    buffer.write(new Float32Array([0.25, 0.5]));
    const out = outputs(2, 2);
    buffer.read(out);
    expect(Array.from(out[0] ?? [])).toEqual([0.25, 0.5]);
    expect(Array.from(out[1] ?? [])).toEqual([0.25, 0.5]);
  });
});
