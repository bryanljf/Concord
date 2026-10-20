import { describe, expect, it } from 'vitest';
import { fitGrid } from './gridLayout';

describe('fitGrid', () => {
  it('always uses 2 columns and ceil(n / 2) rows, with a free slot when n is odd', () => {
    const expected: Array<[number, number, boolean]> = [
      [1, 1, true],
      [2, 1, false],
      [3, 2, true],
      [4, 2, false],
      [5, 3, true],
      [6, 3, false],
      [7, 4, true],
      [8, 4, false],
      [9, 5, true],
    ];
    for (const [n, rows, slot] of expected) {
      const fit = fitGrid(n, 1600, 900, 12);
      expect(fit.cols).toBe(2);
      expect(fit.rows).toBe(rows);
      expect(fit.slot).toBe(slot);
    }
  });

  it('keeps every tile 16:9 and inside the box for n from 1 to 9', () => {
    for (let n = 1; n <= 9; n += 1) {
      for (const [width, height] of [
        [1600, 900],
        [800, 1200],
        [2560, 600],
      ] as const) {
        const { cols, rows, tileWidth, tileHeight } = fitGrid(n, width, height, 12);
        expect(Math.abs(tileHeight - Math.floor((tileWidth * 9) / 16))).toBeLessThanOrEqual(1);
        expect(cols * tileWidth + (cols - 1) * 12).toBeLessThanOrEqual(width);
        expect(rows * tileHeight + (rows - 1) * 12).toBeLessThanOrEqual(height);
      }
    }
  });

  it('is limited by the height in a wide box', () => {
    // 1 row, 600 px tall: 600 * 16 / 9 = 1066 px wide, less than half of 2600.
    expect(fitGrid(2, 2600, 600, 12)).toEqual({
      cols: 2,
      rows: 1,
      tileWidth: 1066,
      tileHeight: 599,
      slot: false,
    });
  });

  it('is limited by the width in a tall box', () => {
    // (1000 - 10) / 2 = 495 px wide; 2 rows would allow much more height.
    expect(fitGrid(3, 1000, 1400, 10)).toEqual({
      cols: 2,
      rows: 2,
      tileWidth: 495,
      tileHeight: 278,
      slot: true,
    });
  });

  it('accounts for the gap between rows', () => {
    // (1000 - 2 * 20) / 3 = 320 px per row, 568 px wide (under (2000 - 20) / 2).
    const fit = fitGrid(6, 2000, 1000, 20);
    expect(fit.rows).toBe(3);
    expect(fit.tileWidth).toBe(568);
    expect(fit.tileHeight).toBe(319);
  });

  it('never returns negative sizes (nothing to show, unmeasured or tiny box)', () => {
    expect(fitGrid(0, 1000, 1000, 12)).toEqual({
      cols: 2,
      rows: 0,
      tileWidth: 0,
      tileHeight: 0,
      slot: false,
    });
    expect(fitGrid(2, 0, 0, 12).tileWidth).toBe(0);
    const tiny = fitGrid(4, 8, 8, 12);
    expect(tiny.tileWidth).toBe(0);
    expect(tiny.tileHeight).toBe(0);
  });
});
