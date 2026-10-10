import type { RoomId } from '@concord/shared';
import { FullscreenIcon, GearIcon, PopOutIcon } from './icons';
import '../styles/header.css';

interface HeaderProps {
  currentRoom: RoomId | null;
  onLeave(): void;
  onOpenSettings(): void;
}

export function Header({ currentRoom, onLeave, onOpenSettings }: HeaderProps) {
  return (
    <header className="header">
      <h1 className="header__title">
        {currentRoom ? (
          <>
            <span className="header__hash" aria-hidden="true">
              #
            </span>
            <span className="header__room">{currentRoom}</span>
          </>
        ) : (
          <span className="header__none">Nenhuma sala</span>
        )}
      </h1>
      {currentRoom && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={onLeave}>
          Sair da sala
        </button>
      )}
      <div className="header__actions">
        <button
          type="button"
          className="icon-btn"
          disabled
          title="Em breve"
          aria-label="Tela cheia (em breve)"
        >
          <FullscreenIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled
          title="Em breve"
          aria-label="Abrir em janela separada (em breve)"
        >
          <PopOutIcon />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Configurações"
          aria-label="Configurações"
          onClick={onOpenSettings}
        >
          <GearIcon />
        </button>
      </div>
    </header>
  );
}
