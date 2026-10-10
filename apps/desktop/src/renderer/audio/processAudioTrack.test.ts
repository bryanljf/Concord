import { describe, expect, it, vi } from 'vitest';

// The module imports the worklet through Vite's `?worker&url`, which Vitest does not resolve.
vi.mock('./pcm-worklet?worker&url', () => ({ default: 'pcm-worklet.js' }));

const { MAX_BUFFERED_MS, PRIME_MS, workletOptions } = await import('./processAudioTrack');

describe('workletOptions', () => {
  it('derives frame counts from the capture format', () => {
    expect(workletOptions({ sampleRate: 48000, channels: 2 })).toEqual({
      channels: 2,
      capacityFrames: (48000 * MAX_BUFFERED_MS) / 1000,
      primeFrames: (48000 * PRIME_MS) / 1000,
    });
  });

  it('never produces zero-frame buffers', () => {
    const options = workletOptions({ sampleRate: 1, channels: 1 });
    expect(options.capacityFrames).toBeGreaterThanOrEqual(1);
    expect(options.primeFrames).toBeGreaterThanOrEqual(1);
    expect(options.primeFrames).toBeLessThanOrEqual(options.capacityFrames);
  });
});
