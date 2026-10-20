import {
  STREAM_FRAME_RATES,
  STREAM_RESOLUTIONS,
  streamQualityId,
  streamQualityOf,
  type StreamQualityId,
} from '@concord/shared';
import '../styles/quality-fields.css';

interface QualityFieldsProps {
  /** Prefix of the selects' ids ("picker", "settings"): both can be mounted at once. */
  idPrefix: string;
  value: StreamQualityId;
  onChange(quality: StreamQualityId): void;
}

/**
 * Resolution (480p–1440p) and frame rate (15/30/60 fps) of a live, side by side. Any pair is
 * valid, and every one keeps its frame rate first (see `encodingParams`).
 */
export function QualityFields({ idPrefix, value, onChange }: QualityFieldsProps) {
  const { height, fps } = streamQualityOf(value);
  return (
    <div className="quality-fields">
      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-resolution`}>
          Resolução
        </label>
        <select
          id={`${idPrefix}-resolution`}
          className="select"
          value={height}
          onChange={(event) => {
            const next = STREAM_RESOLUTIONS.find((r) => r === Number(event.target.value));
            if (next !== undefined) onChange(streamQualityId(next, fps));
          }}
        >
          {STREAM_RESOLUTIONS.map((resolution) => (
            <option key={resolution} value={resolution}>
              {resolution}p
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-fps`}>
          Quadros por segundo
        </label>
        <select
          id={`${idPrefix}-fps`}
          className="select"
          value={fps}
          onChange={(event) => {
            const next = STREAM_FRAME_RATES.find((f) => f === Number(event.target.value));
            if (next !== undefined) onChange(streamQualityId(height, next));
          }}
        >
          {STREAM_FRAME_RATES.map((frameRate) => (
            <option key={frameRate} value={frameRate}>
              {frameRate} fps
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
