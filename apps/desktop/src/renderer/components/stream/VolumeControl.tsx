import type { ReactNode } from 'react';
import {
  MAX_VOLUME,
  MIN_VOLUME,
  VOLUME_STEP,
  volumeIconLevel,
  volumeLabel,
  type VolumeSetting,
} from '../../lib/volume';
import { VolumeHighIcon, VolumeLowIcon, VolumeMutedIcon } from '../icons';

interface VolumeControlProps {
  setting: VolumeSetting;
  /** For the accessible labels ("Volume de Ana"). */
  name: string;
  onVolume(volume: number): void;
  onToggleMute(): void;
  /** Overlay controls call this while the slider is being dragged so they do not auto-hide. */
  onHold?(held: boolean): void;
  compact?: boolean;
}

function iconFor(setting: VolumeSetting): ReactNode {
  switch (volumeIconLevel(setting)) {
    case 'muted':
      return <VolumeMutedIcon size={18} />;
    case 'low':
      return <VolumeLowIcon size={18} />;
    default:
      return <VolumeHighIcon size={18} />;
  }
}

/** Per-stream volume (0–100 %, 70 % by default) and mute. */
export function VolumeControl({
  setting,
  name,
  onVolume,
  onToggleMute,
  onHold,
  compact = false,
}: VolumeControlProps) {
  const label = volumeLabel(setting);
  const muteLabel = setting.muted ? `Ativar o som de ${name}` : `Silenciar ${name}`;
  return (
    <div className={compact ? 'volume volume--compact' : 'volume'}>
      <button
        type="button"
        className="icon-btn icon-btn--overlay"
        aria-label={muteLabel}
        aria-pressed={setting.muted}
        data-tooltip={setting.muted ? 'Ativar som (M)' : 'Silenciar (M)'}
        onClick={onToggleMute}
      >
        {iconFor(setting)}
      </button>
      <input
        type="range"
        className="range"
        min={MIN_VOLUME}
        max={MAX_VOLUME}
        step={VOLUME_STEP}
        value={setting.muted ? 0 : setting.volume}
        aria-label={`Volume de ${name}`}
        aria-valuetext={label}
        title={label}
        onChange={(event) => onVolume(Number(event.target.value))}
        onPointerDown={() => onHold?.(true)}
        onPointerUp={() => onHold?.(false)}
        onPointerCancel={() => onHold?.(false)}
        onBlur={() => onHold?.(false)}
      />
      <span className="volume__value" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}
