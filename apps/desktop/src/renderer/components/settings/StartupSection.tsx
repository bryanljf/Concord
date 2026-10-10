import type { Settings } from '../../lib/concord';
import { SettingsSection } from './SettingsSection';

interface StartupSectionProps {
  settings: Settings;
  onUpdate(patch: Partial<Settings>): void;
}

export function StartupSection({ settings, onUpdate }: StartupSectionProps) {
  return (
    <SettingsSection id="inicializacao" title="Inicialização">
      <label className="switch">
        <span className="switch__text">
          <span className="switch__title">Iniciar com o Windows</span>
          <span className="switch__desc">Abre escondido na bandeja ao ligar o PC.</span>
        </span>
        <input
          type="checkbox"
          checked={settings.launchAtLogin}
          onChange={(event) => onUpdate({ launchAtLogin: event.target.checked })}
        />
      </label>
      <label className="switch">
        <span className="switch__text">
          <span className="switch__title">Abrir junto com o Discord</span>
          <span className="switch__desc">
            Conecta quando o Discord abre e pausa quando ele fecha (se você não estiver
            transmitindo).
          </span>
        </span>
        <input
          type="checkbox"
          checked={settings.followDiscord}
          onChange={(event) => onUpdate({ followDiscord: event.target.checked })}
        />
      </label>
    </SettingsSection>
  );
}
