import { QUALITY_PRESETS, type QualityPresetId } from '@telao/shared';
import { MonitorIcon, StopIcon } from './icons';
import '../styles/bottom-bar.css';

interface BottomBarProps {
  quality: QualityPresetId;
  onStream(): void;
}

export function BottomBar({ quality, onStream }: BottomBarProps) {
  const preset = QUALITY_PRESETS[quality];
  return (
    <footer className="bottom-bar">
      <button type="button" className="btn btn--primary" onClick={onStream}>
        <MonitorIcon size={18} />
        Transmitir
      </button>
      <button type="button" className="btn" disabled title="Nenhuma transmissão ativa">
        <StopIcon size={18} />
        Parar
      </button>
      <span className="bottom-bar__quality">
        qualidade:{' '}
        <strong>
          {preset.label} · {preset.height}p{preset.fps}
        </strong>
      </span>
    </footer>
  );
}
