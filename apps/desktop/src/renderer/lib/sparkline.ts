/**
 * Small time-series charts (the ping tooltip, the stats panel): a fixed window of samples drawn
 * as one SVG path, now at the right edge, 0 at the bottom. Pure, so the geometry is testable.
 */

export interface SeriesSample {
  /** `Date.now()` of the sample. */
  at: number;
  /** Null breaks the line (no answer, no data). */
  value: number | null;
}

export interface SparklinePaths {
  /** Stroke path; one sub-path per run of non-null samples. */
  line: string;
  /** The same runs closed down to the baseline, for the fill. */
  area: string;
}

export interface SparklineBox {
  /** Right edge of the chart. */
  now: number;
  /** Time span from the left edge to the right edge. */
  windowMs: number;
  width: number;
  height: number;
  /** Value at the top edge; higher values are clamped. */
  max: number;
}

/**
 * Keeps the samples of the last `windowMs` (plus one older one so a line reaches the left edge).
 * Samples must be in chronological order.
 */
export function trimHistory<T extends { at: number }>(
  samples: readonly T[],
  now: number,
  windowMs: number,
): T[] {
  const from = now - windowMs;
  const firstInside = samples.findIndex((sample) => sample.at >= from);
  if (firstInside === -1) return samples.length > 0 ? [samples.at(-1) as T] : [];
  return samples.slice(Math.max(0, firstInside - 1));
}

/**
 * Top of a chart: the highest value (times `headroom`) rounded up to `step`, never under `floor`,
 * so a flat line stays low and a busy one keeps a round scale label.
 */
export function niceMax(
  values: readonly (number | null)[],
  floor: number,
  step: number,
  headroom = 1,
): number {
  let max = 0;
  for (const value of values)
    if (value !== null && Number.isFinite(value) && value > max) max = value;
  return Math.max(floor, Math.ceil((max * headroom) / step) * step);
}

const fmt = (value: number): number => Number(value.toFixed(1));

function moveLine(points: readonly { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ');
}

/** SVG paths of `samples` inside `box`: time on x, value on y. Null values break the line. */
export function sparkline(samples: readonly SeriesSample[], box: SparklineBox): SparklinePaths {
  const { now, windowMs, width, height, max } = box;
  const from = now - windowMs;
  const top = max > 0 ? max : 1;
  const x = (at: number) => Math.min(width, Math.max(0, ((at - from) / windowMs) * width));
  const y = (value: number) => height - (Math.min(Math.max(value, 0), top) / top) * height;
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const sample of samples) {
    if (sample.value === null || !Number.isFinite(sample.value)) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push({ x: x(sample.at), y: y(sample.value) });
    }
  }
  if (run.length > 0) runs.push(run);
  const line = runs.map(moveLine).join(' ');
  const area = runs
    .filter((points) => points.length > 1)
    .map((points) => {
      const first = points[0] as { x: number };
      const last = points.at(-1) as { x: number };
      return `${moveLine(points)} L${fmt(last.x)} ${height} L${fmt(first.x)} ${height} Z`;
    })
    .join(' ');
  return { line, area };
}

/**
 * Maps points to a series, inserting a gap where two consecutive points are more than
 * `maxGapMs` apart (sampling stopped: no video, panel hidden) so the line does not bridge it.
 */
export function toSeries<T extends { at: number }>(
  points: readonly T[],
  pick: (point: T) => number | null,
  maxGapMs: number,
): SeriesSample[] {
  const series: SeriesSample[] = [];
  let previous: T | null = null;
  for (const point of points) {
    if (previous && point.at - previous.at > maxGapMs) {
      series.push({ at: previous.at, value: null });
    }
    series.push({ at: point.at, value: pick(point) });
    previous = point;
  }
  return series;
}

/** Lowest and highest non-null value; null when there is none. */
export function seriesRange(samples: readonly SeriesSample[]): { min: number; max: number } | null {
  const values = samples.flatMap((sample) =>
    sample.value === null || !Number.isFinite(sample.value) ? [] : [sample.value],
  );
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
