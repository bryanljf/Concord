import { QUALITY_PRESETS, type QualityPresetId } from '@concord/shared';
import type { BroadcastState } from '../hooks/useBroadcast';
import { presetShortLabel } from '../lib/encoding';
import { Spinner } from './Spinner';
import { MonitorIcon, StopIcon, SwapScreenIcon } from './icons';
import '../styles/bottom-bar.css';

interface BottomBarProps {
  /** Default preset from the settings (shown while idle). */
  defaultQuality: QualityPresetId;
  broadcast: BroadcastState;
  /** A source switch is in progress. */
  switching: boolean;
  onStream(): void;
  /** While live the "Transmitir" button becomes "Trocar fonte". */
  onSwitch(): void;
  onStop(): void;
}

export function BottomBar({
  defaultQuality,
  broadcast,
  switching,
  onStream,
  onSwitch,
  onStop,
}: BottomBarProps) {
  const live = broadcast.status === 'live';
  const busy = broadcast.status === 'starting' || broadcast.status === 'stopping' || switching;
  const quality = live ? broadcast.quality : defaultQuality;
  const preset = QUALITY_PRESETS[quality];

  return (
    <footer className={live ? 'bottom-bar bottom-bar--live' : 'bottom-bar'}>
      {live ? (
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy}
          data-tooltip="Trocar o aplicativo ou a tela transmitida"
          onClick={onSwitch}
        >
          {switching ? <Spinner size="sm" label="Trocando" /> : <SwapScreenIcon size={18} />}
          {switching ? 'Trocando…' : 'Trocar fonte'}
        </button>
      ) : (
        <button type="button" className="btn btn--primary" disabled={busy} onClick={onStream}>
          {broadcast.status === 'starting' ? (
            <Spinner size="sm" label="Iniciando" />
          ) : (
            <MonitorIcon size={18} />
          )}
          {broadcast.status === 'starting' ? 'Iniciando…' : 'Transmitir'}
        </button>
      )}
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
