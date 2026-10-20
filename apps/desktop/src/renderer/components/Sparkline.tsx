import { sparkline, type SeriesSample } from '../lib/sparkline';
import '../styles/sparkline.css';

interface SparklineProps {
  samples: readonly SeriesSample[];
  /** Right edge of the chart (usually the time of the last sample). */
  now: number;
  windowMs: number;
  /** Value at the top edge (see `niceMax`). */
  max: number;
  width: number;
  height: number;
  /** Left side of the caption ("Últimos 30 s", "Perda de pacotes"). */
  caption: string;
  /** Right side of the caption, the numbers in text ("mín 12 · máx 30 ms"). */
  summary: string;
  /** Label of the top grid line ("50 ms"). */
  scaleLabel: string;
  /** Optional second series drawn as a dashed line without fill (e.g. the target fps). */
  secondary?: readonly SeriesSample[];
  className?: string;
}

/** Filled line of a time series with its caption and scale (0 at the bottom, `max` at the top). */
export function Sparkline({
  samples,
  now,
  windowMs,
  max,
  width,
  height,
  caption,
  summary,
  scaleLabel,
  secondary,
  className,
}: SparklineProps) {
  const box = { now, windowMs, width, height, max };
  const { line, area } = sparkline(samples, box);
  const reference = secondary ? sparkline(secondary, box).line : null;
  return (
    <figure className={className ? `sparkline ${className}` : 'sparkline'}>
      <figcaption>
        <span>{caption}</span>
        <span>{summary}</span>
      </figcaption>
      <div className="sparkline__plot">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <line className="sparkline__grid" x1="0" x2={width} y1="0.5" y2="0.5" />
          <line
            className="sparkline__baseline"
            x1="0"
            x2={width}
            y1={height - 0.5}
            y2={height - 0.5}
          />
          <path className="sparkline__area" d={area} />
          {reference && <path className="sparkline__reference" d={reference} />}
          <path className="sparkline__line" d={line} />
        </svg>
        <span className="sparkline__scale">{scaleLabel}</span>
      </div>
    </figure>
  );
}
