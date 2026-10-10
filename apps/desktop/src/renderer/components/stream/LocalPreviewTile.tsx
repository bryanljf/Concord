import { QUALITY_PRESETS, type QualityPresetId } from '@concord/shared';
import { presetShortLabel } from '../../lib/encoding';
import { AudioWaveIcon, StopIcon } from '../icons';
import { LocalPreview } from './LocalPreview';

interface LocalPreviewTileProps {
  track: MediaStreamTrack;
  sourceName: string;
  quality: QualityPresetId;
  hasAudio: boolean;
  /** Large (on the stage, when nobody else streams) or mini (in the strip). */
  focused: boolean;
  onStop(): void;
}

/** Preview of this instance's own broadcast; muted so the publisher never hears themselves. */
export function LocalPreviewTile({
  track,
  sourceName,
  quality,
  hasAudio,
  focused,
  onStop,
}: LocalPreviewTileProps) {
  const preset = QUALITY_PRESETS[quality];
  return (
    <div className={focused ? 'tile tile--focused tile--local' : 'tile tile--mini tile--local'}>
      <LocalPreview track={track} className="tile__video" />
      <div className={focused ? 'tile__top' : 'tile__top tile__top--mini'}>
        <span className="tile__badge badge-live">VOCÊ</span>
        <span className="tile__name">{sourceName}</span>
        {focused && (
          <span className="tile__stats">
            {preset.label} · {presetShortLabel(quality)}
            {hasAudio ? ' · com áudio' : ' · sem áudio'}
          </span>
        )}
        {!focused && hasAudio && <AudioWaveIcon size={14} />}
      </div>
      {focused && (
        <div className="tile__controls tile__controls--static">
          <span className="tile__hint">Prévia da sua transmissão (sem som para você).</span>
          <button type="button" className="btn btn--danger btn--sm" onClick={onStop}>
            <StopIcon size={16} />
            Parar transmissão
          </button>
        </div>
      )}
    </div>
  );
}
