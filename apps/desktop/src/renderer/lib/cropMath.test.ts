import { describe, expect, it, vi } from 'vitest';
import type { CaptureCrop } from '../../preload/api';
import { createThrottledAsk, scaleCrop } from './cropMath';

const crop: CaptureCrop = {
  frameWidth: 1280,
  frameHeight: 752,
  x: 0,
  y: 32,
  width: 1280,
  height: 720,
};

describe('scaleCrop', () => {
  it('uses the crop as is on a frame of the same size', () => {
    expect(scaleCrop(crop, 1280, 752)).toEqual({ x: 0, y: 32, width: 1280, height: 720 });
  });

  it('scales when the capture was downscaled, with even numbers', () => {
    // 1280x752 -> 960x564: y = 24, height = 540.
    expect(scaleCrop(crop, 960, 564)).toEqual({ x: 0, y: 24, width: 960, height: 540 });
    const odd = scaleCrop(
      { ...crop, frameWidth: 1000, frameHeight: 600, x: 7, y: 31, width: 985, height: 569 },
      999,
      599,
    );
    expect(odd).not.toBeNull();
    for (const value of Object.values(odd ?? {})) expect(value % 2).toBe(0);
  });

  it('passes through without a crop, for a stale shape, or when nothing is removed', () => {
    expect(scaleCrop(null, 1280, 752)).toBeNull();
    expect(scaleCrop(crop, 1920, 1080)).toBeNull();
    expect(scaleCrop({ ...crop, y: 0, height: 752 }, 1280, 752)).toBeNull();
  });

  it('clamps inside the frame', () => {
    const rect = scaleCrop({ ...crop, y: 700, height: 500 }, 1280, 752);
    expect(rect).toEqual({ x: 0, y: 700, width: 1280, height: 52 });
  });

  it('ignores degenerate sizes', () => {
    expect(scaleCrop(crop, 0, 0)).toBeNull();
    expect(scaleCrop({ ...crop, width: 1, x: 5 }, 1280, 752)).toBeNull();
  });
});

describe('createThrottledAsk', () => {
  it('asks at once, then at most once per interval with a trailing call', () => {
    vi.useFakeTimers();
    try {
      const ask = vi.fn();
      const throttled = createThrottledAsk(ask, 500);
      throttled.request();
      expect(ask).toHaveBeenCalledTimes(1);
      throttled.request();
      throttled.request();
      expect(ask).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(499);
      expect(ask).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(ask).toHaveBeenCalledTimes(2);
      throttled.request();
      throttled.cancel();
      vi.advanceTimersByTime(1000);
      expect(ask).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
