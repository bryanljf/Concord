import { describe, expect, it } from 'vitest';
import {
  pingLabel,
  pingLevel,
  pingRange,
  pingScaleMax,
  pingSparkline,
  regionLabel,
  trimPingHistory,
} from './ping';

describe('pingLevel', () => {
  it.each<[number | null, number]>([
    [null, 0],
    [-1, 0],
    [Number.NaN, 0],
    [0, 4],
    [60, 4],
    [61, 3],
    [120, 3],
    [121, 2],
    [200, 2],
    [201, 1],
    [900, 1],
  ])('%s ms -> %s bars', (ms, level) => {
    expect(pingLevel(ms)).toBe(level);
  });
});

describe('regionLabel', () => {
  it('names known Oracle regions', () => {
    expect(regionLabel({ region: 'sa-saopaulo-1', provider: 'oracle' })).toBe(
      'São Paulo · Oracle Cloud (sa-saopaulo-1)',
    );
  });

  it('keeps unknown Oracle regions and free labels', () => {
    expect(regionLabel({ region: 'eu-paris-1', provider: 'oracle' })).toBe(
      'Oracle Cloud (eu-paris-1)',
    );
    expect(regionLabel({ region: 'Casa (Campinas)', provider: null })).toBe('Casa (Campinas)');
    expect(regionLabel({ region: null, provider: null })).toBe('Não informada');
  });
});

describe('pingLabel', () => {
  it.each<[number | null, boolean, string]>([
    [23.4, false, '23 ms'],
    [0.4, false, '< 1 ms'],
    [null, false, 'medindo…'],
    [40, true, 'sem resposta'],
  ])('%s / lost=%s -> %s', (ms, lost, label) => {
    expect(pingLabel(ms, lost)).toBe(label);
  });
});

describe('trimPingHistory', () => {
  it('keeps the last 30 s plus one older sample for the left edge', () => {
    const samples = [
      { at: 0, ms: 10 },
      { at: 5_000, ms: 20 },
      { at: 40_000, ms: 30 },
    ];
    expect(trimPingHistory(samples, 40_000)).toEqual(samples.slice(1));
    expect(trimPingHistory(samples, 80_000)).toEqual([{ at: 40_000, ms: 30 }]);
    expect(trimPingHistory([], 0)).toEqual([]);
  });
});

describe('pingScaleMax', () => {
  it('rounds up to 25 ms with a 50 ms floor', () => {
    expect(pingScaleMax([{ at: 0, ms: 12 }])).toBe(50);
    expect(
      pingScaleMax([
        { at: 0, ms: 51 },
        { at: 1, ms: null },
      ]),
    ).toBe(75);
    expect(pingScaleMax([])).toBe(50);
  });
});

describe('pingSparkline', () => {
  it('maps time to x (now at the right) and ms to y (0 at the bottom)', () => {
    const now = 30_000;
    const { line, area } = pingSparkline(
      [
        { at: 0, ms: 0 },
        { at: 30_000, ms: 50 },
      ],
      now,
      100,
      40,
      50,
    );
    expect(line).toBe('M0 40 L100 0');
    expect(area).toBe('M0 40 L100 0 L100 40 L0 40 Z');
  });

  it('breaks the line where a ping got no answer', () => {
    const { line, area } = pingSparkline(
      [
        { at: 0, ms: 25 },
        { at: 15_000, ms: null },
        { at: 30_000, ms: 25 },
      ],
      30_000,
      100,
      40,
      50,
    );
    expect(line).toBe('M0 20 M100 20');
    expect(area).toBe('');
  });
});

describe('pingRange', () => {
  it('ignores unanswered pings', () => {
    expect(
      pingRange([
        { at: 0, ms: 30 },
        { at: 1, ms: null },
        { at: 2, ms: 12 },
      ]),
    ).toEqual({ min: 12, max: 30 });
    expect(pingRange([{ at: 0, ms: null }])).toBeNull();
  });
});
