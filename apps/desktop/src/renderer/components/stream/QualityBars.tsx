import { qualityBars, qualityLabel, toQualityLevel } from '../../lib/connectionQuality';

interface QualityBarsProps {
  /** livekit `ConnectionQuality` value. */
  quality: string;
  size?: number;
}

const HEIGHTS = [5, 9, 13];

/** Three signal bars for a participant's `ConnectionQuality` (SPEC Fase 4). */
export function QualityBars({ quality, size = 16 }: QualityBarsProps) {
  const lit = qualityBars(quality);
  const label = qualityLabel(quality);
  return (
    <span
      className={`quality quality--${toQualityLevel(quality)}`}
      role="img"
      aria-label={label}
      data-tooltip={label}
    >
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false">
        {HEIGHTS.map((height, index) => (
          <rect
            key={height}
            x={1 + index * 5}
            y={15 - height}
            width={4}
            height={height}
            rx={1}
            fill="currentColor"
            opacity={index < lit ? 1 : 0.25}
          />
        ))}
      </svg>
    </span>
  );
}
