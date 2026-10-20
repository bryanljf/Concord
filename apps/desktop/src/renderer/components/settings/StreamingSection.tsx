import type { Settings } from '../../lib/concord';
import { streamQualityDescription } from '../../lib/encoding';
import { EncoderField } from '../EncoderField';
import { QualityFields } from '../QualityFields';
import { SettingsSection } from './SettingsSection';

interface StreamingSectionProps {
  settings: Settings;
  onUpdate(patch: Partial<Settings>): void;
}

const CODECS: { id: Settings['codec']; label: string }[] = [
  { id: 'h264', label: 'H.264 (padrão)' },
  { id: 'vp9', label: 'VP9' },
  { id: 'av1', label: 'AV1' },
];

export function StreamingSection({ settings, onUpdate }: StreamingSectionProps) {
  return (
    <SettingsSection id="transmissao" title="Transmissão">
      <fieldset className="settings__fieldset">
        <legend className="field__label">Qualidade padrão</legend>
        <QualityFields
          idPrefix="settings"
          value={settings.defaultQuality}
          onChange={(quality) => onUpdate({ defaultQuality: quality })}
        />
        <p className="field__hint settings__quality-hint">
          {streamQualityDescription(settings.defaultQuality)}. Em qualquer combinação os quadros vêm
          primeiro: se faltar CPU, cai a resolução, não o fps.
        </p>
      </fieldset>
      <EncoderField
        idPrefix="settings"
        value={settings.videoEncoder}
        onChange={(videoEncoder) => onUpdate({ videoEncoder })}
      />
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
