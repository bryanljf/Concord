import { useEffect, useState } from 'react';
import type { Settings } from '../../lib/concord';
import { SettingsSection } from './SettingsSection';

interface AudioSectionProps {
  settings: Settings;
  onUpdate(patch: Partial<Settings>): void;
}

interface OutputDevice {
  id: string;
  label: string;
}

export function AudioSection({ settings, onUpdate }: AudioSectionProps) {
  const [devices, setDevices] = useState<OutputDevice[]>([]);

  useEffect(() => {
    let active = true;
    navigator.mediaDevices.enumerateDevices().then(
      (list) => {
        if (!active) return;
        setDevices(
          list
            .filter((device) => device.kind === 'audiooutput' && device.deviceId !== 'default')
            .map((device, index) => ({
              id: device.deviceId,
              label: device.label || `Dispositivo ${index + 1}`,
            })),
        );
      },
      () => {
        // Leave the list empty; the system default is always offered.
      },
    );
    return () => {
      active = false;
    };
  }, []);

  const selected = settings.audioOutputDeviceId ?? '';
  const selectedIsUnknown = selected !== '' && !devices.some((device) => device.id === selected);

  return (
    <SettingsSection id="audio" title="Áudio">
      <div className="field">
        <label className="field__label" htmlFor="settings-audio-output">
          Saída de áudio das transmissões
        </label>
        <select
          id="settings-audio-output"
          className="select"
          value={selected}
          onChange={(event) => onUpdate({ audioOutputDeviceId: event.target.value || null })}
        >
          <option value="">Padrão do sistema</option>
          {selectedIsUnknown && <option value={selected}>Dispositivo salvo (desconectado)</option>}
          {devices.map((device) => (
            <option key={device.id} value={device.id}>
              {device.label}
            </option>
          ))}
        </select>
        <p className="field__hint">
          Independente do Discord: dá para mandar o som das streams para outro fone ou caixa. Vale a
          partir da Fase 3.
        </p>
      </div>
    </SettingsSection>
  );
}
