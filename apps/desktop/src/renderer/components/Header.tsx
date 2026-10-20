import { roomLabel, type RoomId } from '@concord/shared';
import { ExitFullscreenIcon, FullscreenIcon, GearIcon, PopOutIcon } from './icons';
import '../styles/header.css';

interface HeaderProps {
  currentRoom: RoomId | null;
  /**
   * What plays big on the stage, which the "another window" button acts on: a screen share
   * goes to the pop-out, a webcam to the cameras' picture-in-picture; null disables it.
   */
  focusedKind: 'screen' | 'camera' | null;
  fullscreen: boolean;
  onToggleFullscreen(): void;
  onPopout(): void;
  onOpenSettings(): void;
}

export function Header({
  currentRoom,
  focusedKind,
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
          disabled={focusedKind === null}
          data-tooltip={
            focusedKind === 'camera'
              ? 'Picture-in-picture'
              : focusedKind === 'screen'
                ? 'Abrir em janela separada'
                : 'Destaque uma transmissão primeiro'
          }
          aria-label={
            focusedKind === 'camera'
              ? 'Abrir as câmeras em picture-in-picture'
              : 'Abrir a transmissão em destaque em uma janela separada'
          }
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
