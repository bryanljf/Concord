import { roomLabel, type RoomId } from '@concord/shared';
import { ExitFullscreenIcon, FullscreenIcon, GearIcon, PopOutIcon } from './icons';
import '../styles/header.css';

/**
 * What the "another window" button does: the desktop's windows (the pop-out for a screen share,
 * the cameras' picture-in-picture for a webcam), the browser's own picture-in-picture of the
 * stream (web client), or nothing (the button is left out).
 */
export type WindowMode = 'desktop' | 'native' | 'none';

interface HeaderProps {
  currentRoom: RoomId | null;
  /**
   * What plays big on the stage, which the "another window" button acts on: a screen share
   * goes to the pop-out, a webcam to the cameras' picture-in-picture; null disables it.
   */
  focusedKind: 'screen' | 'camera' | null;
  fullscreen: boolean;
  windowMode?: WindowMode;
  onToggleFullscreen(): void;
  onPopout(): void;
  onOpenSettings(): void;
}

export function Header({
  currentRoom,
  focusedKind,
  fullscreen,
  windowMode = 'desktop',
  onToggleFullscreen,
  onPopout,
  onOpenSettings,
}: HeaderProps) {
  let popoutTooltip = 'Destaque uma transmissão primeiro';
  let popoutLabel = 'Abrir a transmissão em destaque em picture-in-picture';
  if (windowMode === 'desktop') {
    if (focusedKind === 'camera') popoutTooltip = 'Picture-in-picture';
    else if (focusedKind === 'screen') popoutTooltip = 'Abrir em janela separada';
    popoutLabel =
      focusedKind === 'camera'
        ? 'Abrir as câmeras em picture-in-picture'
        : 'Abrir a transmissão em destaque em uma janela separada';
  } else if (focusedKind !== null) {
    popoutTooltip = 'Picture-in-picture';
  }
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
        {windowMode !== 'none' && (
          <button
            type="button"
            className="icon-btn"
            disabled={focusedKind === null}
            data-tooltip={popoutTooltip}
            aria-label={popoutLabel}
            onClick={onPopout}
          >
            <PopOutIcon />
          </button>
        )}
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
