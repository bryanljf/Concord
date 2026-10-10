import { QUALITY_PRESETS, type QualityPresetId } from '@telao/shared';
import type { Settings } from '../../lib/telao';
import { SettingsSection } from './SettingsSection';

interface StreamingSectionProps {
  settings: Settings;
  onUpdate(patch: Partial<Settings>): void;
}

const PRESET_IDS: QualityPresetId[] = ['light', 'standard', 'game'];

const CODECS: { id: Settings['codec']; label: string }[] = [
  { id: 'h264', label: 'H.264 (padrão)' },
  { id: 'vp9', label: 'VP9' },
  { id: 'av1', label: 'AV1' },
];

function describePreset(id: QualityPresetId): string {
  const preset = QUALITY_PRESETS[id];
  const mbps = (preset.maxBitrate / 1_000_000).toLocaleString('pt-BR');
  return `${preset.height}p${preset.fps} · até ${mbps} Mbps`;
}

export function StreamingSection({ settings, onUpdate }: StreamingSectionProps) {
  return (
    <SettingsSection id="transmissao" title="Transmissão">
      <fieldset className="settings__fieldset">
        <legend className="field__label">Qualidade padrão</legend>
        <div className="radio-group">
          {PRESET_IDS.map((id) => (
            <label key={id} className="radio">
              <input
                type="radio"
                name="default-quality"
                value={id}
                checked={settings.defaultQuality === id}
                onChange={() => onUpdate({ defaultQuality: id })}
              />
              <span className="radio__text">
                <span className="radio__title">{QUALITY_PRESETS[id].label}</span>
                <span className="radio__desc">{describePreset(id)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label className="field__label" htmlFor="settings-codec">
          Codec de vídeo (avançado)
        </label>
        <select
          id="settings-codec"
          className="select"
          value={settings.codec}
          onChange={(event) => onUpdate({ codec: event.target.value as Settings['codec'] })}
        >
          {CODECS.map((codec) => (
            <option key={codec.id} value={codec.id}>
              {codec.label}
            </option>
          ))}
        </select>
        <p className="field__hint">
          H.264 tem o melhor suporte a encoder de hardware. Mude só se souber o que está fazendo.
        </p>
      </div>
    </SettingsSection>
  );
}
