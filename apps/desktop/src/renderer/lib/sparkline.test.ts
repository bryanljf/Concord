import { describe, expect, it } from 'vitest';
import { niceMax, seriesRange, sparkline, toSeries, trimHistory } from './sparkline';

describe('trimHistory', () => {
  it('keeps the window plus one older sample for the left edge', () => {
    const samples = [{ at: 0 }, { at: 5_000 }, { at: 12_000 }];
    expect(trimHistory(samples, 12_000, 10_000)).toEqual(samples);
    expect(trimHistory(samples, 16_000, 10_000)).toEqual(samples.slice(1));
    expect(trimHistory(samples, 30_000, 10_000)).toEqual([{ at: 12_000 }]);
    expect(trimHistory([], 0, 10_000)).toEqual([]);
  });
});

describe('niceMax', () => {
  it('rounds the highest value (with headroom) up to the step, never under the floor', () => {
    expect(niceMax([0.4, null, 1.2], 5, 5)).toBe(5);
    expect(niceMax([7], 5, 5)).toBe(10);
    expect(niceMax([28, 30], 10, 10, 1.15)).toBe(40);
    expect(niceMax([60], 10, 10, 1.15)).toBe(70);
    expect(niceMax([Number.NaN], 10, 10)).toBe(10);
  });
});

describe('sparkline', () => {
  it('draws the window with now at the right edge, clamping values to [0, max]', () => {
    const box = { now: 20_000, windowMs: 20_000, width: 100, height: 50, max: 10 };
    const { line, area } = sparkline(
      [
        { at: 0, value: 0 },
        { at: 10_000, value: 20 },
        { at: 20_000, value: 5 },
      ],
      box,
    );
    expect(line).toBe('M0 50 L50 0 L100 25');
    expect(area).toBe('M0 50 L50 0 L100 25 L100 50 L0 50 Z');
  });

  it('breaks the line on null values', () => {
    const box = { now: 20_000, windowMs: 20_000, width: 100, height: 50, max: 10 };
    const { line, area } = sparkline(
      [
        { at: 0, value: 5 },
        { at: 10_000, value: null },
        { at: 15_000, value: 5 },
        { at: 20_000, value: 10 },
      ],
      box,
    );
    expect(line).toBe('M0 25 M75 25 L100 0');
    expect(area).toBe('M75 25 L100 0 L100 50 L75 50 Z');
  });
});

describe('toSeries', () => {
  it('inserts a gap where two points are too far apart', () => {
    const points = [
      { at: 1_000, fps: 30 },
      { at: 2_000, fps: 29 },
      { at: 9_000, fps: 30 },
    ];
    expect(toSeries(points, (point) => point.fps, 2_500)).toEqual([
      { at: 1_000, value: 30 },
      { at: 2_000, value: 29 },
      { at: 2_000, value: null },
      { at: 9_000, value: 30 },
    ]);
  });
});

describe('seriesRange', () => {
  it('ignores gaps', () => {
    expect(
      seriesRange([
        { at: 0, value: 3 },
        { at: 1, value: null },
        { at: 2, value: 1 },
      ]),
    ).toEqual({ min: 1, max: 3 });
    expect(seriesRange([{ at: 0, value: null }])).toBeNull();
  });
});
