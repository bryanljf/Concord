import { roomLabel, type RoomId } from '@concord/shared';
import { ExitFullscreenIcon, FullscreenIcon, GearIcon, PopOutIcon } from './icons';
import '../styles/header.css';

interface HeaderProps {
  currentRoom: RoomId | null;
  /** A remote stream is on the stage (pop-out and fullscreen act on it). */
  hasFocusedStream: boolean;
  fullscreen: boolean;
  onToggleFullscreen(): void;
  onPopout(): void;
  onOpenSettings(): void;
}

export function Header({
  currentRoom,
  hasFocusedStream,
  fullscreen,
  onToggleFullscreen,
  onPopout,
  onOpenSettings,
}: HeaderProps) {
  return (
    <header className="header">
      <h1 className="header__title">
        {currentRoom ? (
          <span className="header__room">{roomLabel(currentRoom)}</span>
        ) : (
          <span className="header__none">Nenhuma sala</span>
        )}
      </h1>
      <div className="header__actions">
        <button
          type="button"
          className="icon-btn"
          disabled={!currentRoom}
          data-tooltip={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia (F11)'}
          aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled={!hasFocusedStream}
          data-tooltip={
            hasFocusedStream ? 'Abrir em janela separada' : 'Destaque uma transmissão primeiro'
          }
          aria-label="Abrir a transmissão em destaque em uma janela separada"
          onClick={onPopout}
        >
          <PopOutIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          data-tooltip="Configurações"
          aria-label="Configurações"
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
