import { QUALITY_PRESETS, type QualityPresetId } from '@concord/shared';
import type { BroadcastState } from '../hooks/useBroadcast';
import { presetShortLabel } from '../lib/encoding';
import { Spinner } from './Spinner';
import { MonitorIcon, StopIcon } from './icons';
import '../styles/bottom-bar.css';

interface BottomBarProps {
  /** Default preset from the settings (shown while idle). */
  defaultQuality: QualityPresetId;
  broadcast: BroadcastState;
  onStream(): void;
  onStop(): void;
}

export function BottomBar({ defaultQuality, broadcast, onStream, onStop }: BottomBarProps) {
  const live = broadcast.status === 'live';
  const busy = broadcast.status === 'starting' || broadcast.status === 'stopping';
  const quality = live ? broadcast.quality : defaultQuality;
  const preset = QUALITY_PRESETS[quality];

  return (
    <footer className={live ? 'bottom-bar bottom-bar--live' : 'bottom-bar'}>
      <button
        type="button"
        className="btn btn--primary"
        disabled={live || busy}
        data-tooltip={live ? 'Pare a transmissão atual primeiro' : undefined}
        onClick={onStream}
      >
        {broadcast.status === 'starting' ? (
          <Spinner size="sm" label="Iniciando" />
        ) : (
          <MonitorIcon size={18} />
        )}
        {broadcast.status === 'starting' ? 'Iniciando…' : 'Transmitir'}
      </button>
      <button
        type="button"
        className={live ? 'btn btn--danger' : 'btn'}
        disabled={!live}
        data-tooltip={live ? undefined : 'Nenhuma transmissão ativa'}
        onClick={onStop}
      >
        <StopIcon size={18} />
        {broadcast.status === 'stopping' ? 'Parando…' : 'Parar'}
      </button>
      {live && (
        <span className="bottom-bar__live" role="status">
          <span className="bottom-bar__live-dot" aria-hidden="true" />
          AO VIVO · <strong>{broadcast.sourceName}</strong>
        </span>
      )}
      <span className="bottom-bar__quality">
        qualidade:{' '}
        <strong>
          {preset.label} · {presetShortLabel(quality)}
        </strong>
      </span>
    </footer>
  );
}
