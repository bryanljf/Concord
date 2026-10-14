import type { ServerInfoResponse } from '@concord/shared';

/** 0 = unknown or no answer; 1 (red) … 4 (green) lit bars. */
export type PingLevel = 0 | 1 | 2 | 3 | 4;

/** Upper bound (ms, inclusive) of each level from the best down: ≤ 60 green, ≤ 120 yellow, … */
const THRESHOLDS: readonly [number, PingLevel][] = [
  [60, 4],
  [120, 3],
  [200, 2],
];

export function pingLevel(ms: number | null): PingLevel {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 0;
  for (const [limit, level] of THRESHOLDS) if (ms <= limit) return level;
  return 1;
}

/** Oracle Cloud region ids in the Americas (where the group plays) → city names. */
const ORACLE_REGIONS: Record<string, string> = {
  'sa-saopaulo-1': 'São Paulo',
  'sa-vinhedo-1': 'Vinhedo',
  'sa-santiago-1': 'Santiago',
  'sa-valparaiso-1': 'Valparaíso',
  'sa-bogota-1': 'Bogotá',
  'mx-queretaro-1': 'Querétaro',
  'mx-monterrey-1': 'Monterrey',
  'us-ashburn-1': 'Ashburn',
  'us-phoenix-1': 'Phoenix',
  'us-sanjose-1': 'San Jose',
  'us-chicago-1': 'Chicago',
  'ca-toronto-1': 'Toronto',
  'ca-montreal-1': 'Montreal',
};

/** "São Paulo · Oracle Cloud (sa-saopaulo-1)", a free label as is, or "Não informada". */
export function regionLabel(info: Pick<ServerInfoResponse, 'region' | 'provider'>): string {
  if (!info.region) return 'Não informada';
  if (info.provider !== 'oracle') return info.region;
  const city = ORACLE_REGIONS[info.region];
  return city ? `${city} · Oracle Cloud (${info.region})` : `Oracle Cloud (${info.region})`;
}

/** "23 ms", "< 1 ms", "medindo…" or "sem resposta". */
export function pingLabel(ms: number | null, lost: boolean): string {
  if (lost) return 'sem resposta';
  if (ms === null) return 'medindo…';
  return ms < 1 ? '< 1 ms' : `${Math.round(ms)} ms`;
}

/** How much history the tooltip chart shows. */
export const PING_HISTORY_MS = 30_000;

export interface PingSample {
  /** `Date.now()` when the answer (or the timeout) arrived. */
  at: number;
  /** Null when the ping got no answer: a gap in the chart. */
  ms: number | null;
}

/** Keeps the samples of the last `PING_HISTORY_MS` (plus one older one so the line reaches the left edge). */
export function trimPingHistory(samples: readonly PingSample[], now: number): PingSample[] {
  const from = now - PING_HISTORY_MS;
  const firstInside = samples.findIndex((sample) => sample.at >= from);
  if (firstInside === -1) return samples.length > 0 ? [samples.at(-1) as PingSample] : [];
  return samples.slice(Math.max(0, firstInside - 1));
}

/** Top of the chart: the highest ping rounded up to 25 ms, never under 50 ms (a flat line stays low). */
export function pingScaleMax(samples: readonly PingSample[]): number {
  let max = 0;
  for (const sample of samples) if (sample.ms !== null && sample.ms > max) max = sample.ms;
  return Math.max(50, Math.ceil(max / 25) * 25);
}

export interface SparklinePaths {
  /** Stroke path; one sub-path per run of answered pings. */
  line: string;
  /** The same runs closed down to the baseline, for the fill. */
  area: string;
}

/**
 * SVG paths of the ping over the last 30 s in a `width`×`height` box: time on x (now at the right
 * edge), ms on y from 0 at the bottom to `max` at the top. Unanswered pings break the line.
 */
export function pingSparkline(
  samples: readonly PingSample[],
  now: number,
  width: number,
  height: number,
  max: number = pingScaleMax(samples),
): SparklinePaths {
  const from = now - PING_HISTORY_MS;
  const x = (at: number) => Math.min(width, Math.max(0, ((at - from) / PING_HISTORY_MS) * width));
  const y = (ms: number) => height - (Math.min(ms, max) / max) * height;
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  for (const sample of samples) {
    if (sample.ms === null) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push({ x: x(sample.at), y: y(sample.ms) });
    }
  }
  if (run.length > 0) runs.push(run);
  const fmt = (value: number) => Number(value.toFixed(1));
  const line = runs
    .map((points) =>
      points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' '),
    )
    .join(' ');
  const area = runs
    .filter((points) => points.length > 1)
    .map((points) => {
      const first = points[0] as { x: number };
      const last = points.at(-1) as { x: number };
      const top = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p.x)} ${fmt(p.y)}`).join(' ');
      return `${top} L${fmt(last.x)} ${height} L${fmt(first.x)} ${height} Z`;
    })
    .join(' ');
  return { line, area };
}

/** Lowest and highest answered ping in the window; null when nothing answered. */
export function pingRange(samples: readonly PingSample[]): { min: number; max: number } | null {
  const values = samples.flatMap((sample) => (sample.ms === null ? [] : [sample.ms]));
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
