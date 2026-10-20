import { describe, expect, it } from 'vitest';
import {
  MARQUEE_BACK_PX_S,
  MARQUEE_END_PAUSE_MS,
  MARQUEE_FORWARD_PX_S,
  MARQUEE_START_PAUSE_MS,
  marqueeKeyframes,
} from './marquee';

describe('marqueeKeyframes', () => {
  it('pauses, slides to the end, pauses and glides back more slowly', () => {
    const { keyframes, duration } = marqueeKeyframes(80);
    const forward = (80 / MARQUEE_FORWARD_PX_S) * 1000;
    const back = (80 / MARQUEE_BACK_PX_S) * 1000;
    expect(back).toBeGreaterThan(forward);
    expect(duration).toBe(MARQUEE_START_PAUSE_MS + forward + MARQUEE_END_PAUSE_MS + back);
    expect(keyframes.map((frame) => frame.transform)).toEqual([
      'translateX(0)',
      'translateX(0)',
      'translateX(-80px)',
      'translateX(-80px)',
      'translateX(0)',
    ]);
    const offsets = keyframes.map((frame) => frame.offset as number);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(1);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('never moves for text that fits', () => {
    const { keyframes } = marqueeKeyframes(-5);
    expect(new Set(keyframes.map((frame) => frame.transform))).toEqual(
      new Set(['translateX(0)', 'translateX(0px)']),
    );
  });
});
