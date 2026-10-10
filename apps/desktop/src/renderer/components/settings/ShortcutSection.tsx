import type { Settings } from '../../lib/concord';
import { ShortcutRecorder } from '../ShortcutRecorder';
import { SettingsSection } from './SettingsSection';

interface ShortcutSectionProps {
  settings: Settings;
  platform: string;
  onUpdate(patch: Partial<Settings>): void;
}

export function ShortcutSection({ settings, platform, onUpdate }: ShortcutSectionProps) {
  return (
    <SettingsSection id="atalho" title="Atalho">
      <div className="field">
        <label className="field__label" htmlFor="settings-shortcut">
          Iniciar / parar transmissão
        </label>
        <ShortcutRecorder
          id="settings-shortcut"
          value={settings.shortcut}
          platform={platform}
          onChange={(shortcut) => onUpdate({ shortcut })}
        />
        <p className="field__hint">
          Atalho global: funciona mesmo com o jogo em primeiro plano. Evite combinações que o jogo
          já usa.
        </p>
      </div>
    </SettingsSection>
  );
}
