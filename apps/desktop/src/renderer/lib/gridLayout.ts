/**
 * Geometry of the stage grid (2 or more watched streams): always 2 columns, as many rows as
 * needed, every tile the same 16:9 size, the largest that fits. Pure so it can be unit-tested;
 * `components/Stage.tsx` measures the container with `hooks/useElementSize.ts`.
 */

export const GRID_COLUMNS = 2;

/** Width / height of every tile. */
export const TILE_ASPECT = 16 / 9;

export interface GridFit {
  cols: number;
  rows: number;
  /** Whole pixels, so the tiles line up without blurry half-pixel edges. */
  tileWidth: number;
  tileHeight: number;
  /** An odd count leaves the last cell free: it shows the "Transmitir" slot. */
  slot: boolean;
}

/**
 * The largest 16:9 tile that fits `n` tiles in 2 columns and `ceil(n / 2)` rows inside a
 * `width` × `height` box with `gap` pixels between tiles. Limited by the width in a wide box
 * and by the height in a tall one; never negative.
 */
export function fitGrid(n: number, width: number, height: number, gap: number): GridFit {
  const count = Math.max(0, Math.floor(n));
  const cols = GRID_COLUMNS;
  const rows = Math.ceil(count / cols);
  const slot = count % 2 === 1;
  if (rows === 0 || width <= 0 || height <= 0) {
    return { cols, rows, tileWidth: 0, tileHeight: 0, slot };
  }
  const cellWidth = (width - gap * (cols - 1)) / cols;
  const cellHeight = (height - gap * (rows - 1)) / rows;
  const tileWidth = Math.max(0, Math.floor(Math.min(cellWidth, cellHeight * TILE_ASPECT)));
  const tileHeight = Math.floor(tileWidth / TILE_ASPECT);
  return { cols, rows, tileWidth, tileHeight, slot };
}
