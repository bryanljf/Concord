import { useEffect, useRef, useState } from 'react';
import type { PresenceParticipant, RoomId, UserInfo } from '@concord/shared';
import type { ClientCapabilities } from '../../../preload/api';
import { audioOutputSelectable, capabilities } from '../../lib/capabilities';
import type { Settings } from '../../lib/concord';
import { CloseIcon } from '../icons';
import { AboutSection } from './AboutSection';
import { AccountSection } from './AccountSection';
import { AudioSection } from './AudioSection';
import { CameraSection } from './CameraSection';
import { NotificationsSection } from './NotificationsSection';
import { ShortcutSection } from './ShortcutSection';
import { StartupSection } from './StartupSection';
import { StreamingSection } from './StreamingSection';
import '../../styles/settings.css';

const SECTIONS = [
  { id: 'conta', label: 'Conta' },
  { id: 'inicializacao', label: 'Inicialização' },
  { id: 'atalho', label: 'Atalho' },
  { id: 'transmissao', label: 'Transmissão' },
  { id: 'notificacoes', label: 'Sons' },
  { id: 'audio', label: 'Áudio' },
  { id: 'camera', label: 'Câmera' },
  { id: 'sobre', label: 'Sobre' },
] as const;

export type SettingsSectionId = (typeof SECTIONS)[number]['id'];

/**
 * Which sections exist on this client: the web keeps Conta, Sons, Câmera and Sobre, plus Áudio
 * where the browser lets the output device be chosen.
 */
function sectionShown(id: SettingsSectionId, can: ClientCapabilities, audioOutput: boolean) {
  switch (id) {
    case 'inicializacao':
      return can.tray;
    case 'atalho':
      return can.shortcut;
    case 'transmissao':
      return can.screenShare;
    case 'audio':
      return audioOutput;
    case 'camera':
      return can.camera;
    default:
      return true;
  }
}

interface SettingsViewProps {
  settings: Settings;
  /** Last persistence error from `useSettings`, if any. */
  error: string | null;
  user: UserInfo;
  /** Section shown when the view opens (default: Conta). */
  initialSection?: SettingsSectionId;
  /** Focus the display-name field on open (opened from the user panel). */
  focusNickname?: boolean;
  rooms: RoomId[];
  participants: PresenceParticipant[];
  platform: string;
  version: string;
  onUpdate(patch: Partial<Settings>): void;
  onClose(): void;
  onRekey(): void;
  onSetNickname(nickname: string | null): Promise<UserInfo>;
}

/** Full-page settings (Discord-like: section list on the left, ESC to close). */
export function SettingsView({
  settings,
  error,
  user,
  initialSection = 'conta',
  focusNickname = false,
  rooms,
  participants,
  platform,
  version,
  onUpdate,
  onClose,
  onRekey,
  onSetNickname,
}: SettingsViewProps) {
  const [active, setActive] = useState<SettingsSectionId>(initialSection);
  const can = capabilities();
  const audioOutput = audioOutputSelectable();
  const shown = (id: SettingsSectionId): boolean => sectionShown(id, can, audioOutput);

  // Opening straight on another section: scroll it into view once, on mount.
  const initialRef = useRef(initialSection);
  useEffect(() => {
    if (initialRef.current === 'conta') return;
    document.getElementById(`settings-${initialRef.current}`)?.scrollIntoView({ block: 'start' });
  }, []);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function jumpTo(id: SettingsSectionId) {
    setActive(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ block: 'start' });
  }

  return (
    <div className="settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <nav className="settings__nav" aria-label="Seções das configurações">
        <h1 id="settings-title" className="settings__nav-title">
          Configurações
        </h1>
        {SECTIONS.filter((section) => shown(section.id)).map((section) => (
          <button
            key={section.id}
            type="button"
            aria-current={active === section.id ? 'true' : undefined}
            onClick={() => jumpTo(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
      <div className="settings__content">
        {error && (
          <p className="settings__error" role="alert">
            {error}
          </p>
        )}
        <AccountSection
          user={user}
          serverUrl={can.serverChoice ? settings.serverUrl : null}
          focusNickname={focusNickname}
          onRekey={onRekey}
          onSetNickname={onSetNickname}
        />
        {shown('inicializacao') && <StartupSection settings={settings} onUpdate={onUpdate} />}
        {shown('atalho') && (
          <ShortcutSection settings={settings} platform={platform} onUpdate={onUpdate} />
        )}
        {shown('transmissao') && <StreamingSection settings={settings} onUpdate={onUpdate} />}
        <NotificationsSection
          settings={settings}
          rooms={rooms}
          participants={participants}
          onUpdate={onUpdate}
        />
        {shown('audio') && (
          <AudioSection settings={settings} popout={can.popout} onUpdate={onUpdate} />
        )}
        {shown('camera') && <CameraSection settings={settings} pip={can.pip} onUpdate={onUpdate} />}
        <AboutSection version={version} platform={platform} updates={can.updates} />
      </div>
      <div className="settings__close">
        <button
          type="button"
          className="settings__close-btn"
          aria-label="Fechar configurações"
          autoFocus={!focusNickname}
          onClick={onClose}
        >
          <CloseIcon size={18} />
        </button>
        <span aria-hidden="true">ESC</span>
      </div>
    </div>
  );
}
