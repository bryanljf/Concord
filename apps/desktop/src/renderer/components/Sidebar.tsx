import { useState, type KeyboardEvent } from 'react';
import type { JamState, PresenceSnapshot, RoomId } from '@concord/shared';
import logoUrl from '../../../resources/icon.png';
import { useNow } from '../hooks/useNow';
import { useToast } from '../hooks/useToast';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import { toErrorMessage } from '../lib/concord';
import { participantsOf } from '../lib/presence';
import { ChevronsLeftIcon, ChevronsRightIcon, UpdateArrowIcon, WarningIcon } from './icons';
import { RoomIcon } from './RoomIcon';
import { RoomItem } from './RoomItem';
import '../styles/sidebar.css';

interface SidebarBrandProps {
  /** The rooms below are reduced to a column of icons (`Settings.sidebarCollapsed`). */
  collapsed: boolean;
  onToggleCollapsed(): void;
}

const UPDATE_LABEL = 'Atualização disponível';

/**
 * Discord-like green arrow once an update is downloaded (`ready`): a click restarts the app to
 * install it. Nothing in any other state.
 */
function SidebarUpdate() {
  const { status, install } = useUpdateStatus();
  const toast = useToast();
  const [installing, setInstalling] = useState(false);
  if (status.state !== 'ready') return null;

  const restart = (): void => {
    setInstalling(true);
    install().catch((err: unknown) => {
      setInstalling(false);
      toast.show(toErrorMessage(err, 'Não foi possível instalar a atualização.'), {
        tone: 'error',
      });
    });
  };

  return (
    <button
      type="button"
      className="icon-btn sidebar__update"
      aria-label={UPDATE_LABEL}
      data-tooltip={UPDATE_LABEL}
      disabled={installing}
      onClick={restart}
    >
      <UpdateArrowIcon size={18} />
    </button>
  );
}

/**
 * The "CONCORD" row above the rooms, with the collapse toggle at its right end and, right after
 * the name, the update arrow. Collapsed, the name gives way to the app's logo (the same icon as
 * the installer, window and tray) and the arrow is left out.
 */
export function SidebarBrand({ collapsed, onToggleCollapsed }: SidebarBrandProps) {
  const label = collapsed ? 'Expandir a barra lateral' : 'Recolher a barra lateral';
  return (
    <div className={collapsed ? 'sidebar__brand sidebar__brand--collapsed' : 'sidebar__brand'}>
      {collapsed ? (
        <img className="sidebar__logo" src={logoUrl} alt="Concord" draggable={false} />
      ) : (
        <>
          <span className="sidebar__brand-name">CONCORD</span>
          <SidebarUpdate />
        </>
      )}
      <button
        type="button"
        className="icon-btn sidebar__toggle"
        aria-label={label}
        data-tooltip={label}
        onClick={onToggleCollapsed}
      >
        {collapsed ? <ChevronsRightIcon size={18} /> : <ChevronsLeftIcon size={18} />}
      </button>
    </div>
  );
}

interface SidebarProps {
  rooms: RoomId[];
  snapshot: PresenceSnapshot;
  currentRoom: RoomId | null;
  /**
   * Stream keys watched in the current room; a screen share's key is the participant id, so its
   * badge reads "assistindo" (camera keys never match a participant).
   */
  watchedIds: readonly string[];
  /** Every room's Jam (only rooms with one; empty without the Jam). */
  jamRooms: Readonly<Record<RoomId, JamState>>;
  /** How many music you listen to in your room: its Jam (your room's music button says so). */
  musicListening: number;
  musicOpen: boolean;
  /** Just a column of room icons (`Settings.sidebarCollapsed`). */
  collapsed: boolean;
  onToggleMusic(): void;
  onJoin(room: RoomId): void;
  onWatch(room: RoomId, participantId: string): void;
}

/** Arrow keys move between rooms and "AO VIVO" buttons (all marked with `data-navitem`). */
function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-navitem]'));
  const index = items.findIndex((item) => item === document.activeElement);
  if (index === -1 || items.length === 0) return;
  event.preventDefault();
  const step = event.key === 'ArrowDown' ? 1 : -1;
  items[(index + step + items.length) % items.length]?.focus();
}

const NONE: readonly string[] = [];
const NO_ROOMS = 'Nenhuma sala disponível. Verifique a conexão com o servidor.';

export function Sidebar({
  rooms,
  snapshot,
  currentRoom,
  watchedIds,
  jamRooms,
  musicListening,
  musicOpen,
  collapsed,
  onToggleMusic,
  onJoin,
  onWatch,
}: SidebarProps) {
  const now = useNow();

  if (collapsed) {
    return (
      <nav className="sidebar sidebar--collapsed" aria-label="Salas" onKeyDown={handleKeyDown}>
        {rooms.length === 0 ? (
          <p className="sidebar__empty sidebar__empty--icon" title={NO_ROOMS}>
            <WarningIcon size={20} />
            <span className="sr-only">{NO_ROOMS}</span>
          </p>
        ) : (
          <ul className="sidebar__icons">
            {rooms.map((room) => (
              <RoomIcon
                key={room}
                room={room}
                participants={participantsOf(snapshot, room)}
                current={room === currentRoom}
                jam={jamRooms[room] ?? null}
                onJoin={onJoin}
              />
            ))}
          </ul>
        )}
      </nav>
    );
  }

  return (
    <nav className="sidebar" aria-label="Salas" onKeyDown={handleKeyDown}>
      <h2 className="sidebar__section">
        <span>Salas</span>
        <span aria-hidden="true">{rooms.length}</span>
      </h2>
      {rooms.length === 0 ? (
        <p className="sidebar__empty">{NO_ROOMS}</p>
      ) : (
        <ul className="sidebar__rooms">
          {rooms.map((room) => (
            <RoomItem
              key={room}
              room={room}
              participants={participantsOf(snapshot, room)}
              current={room === currentRoom}
              watchedIds={room === currentRoom ? watchedIds : NONE}
              musicListening={room === currentRoom ? musicListening : 0}
              jam={jamRooms[room] ?? null}
              musicOpen={musicOpen}
              onToggleMusic={onToggleMusic}
              now={now}
              onJoin={onJoin}
              onWatch={onWatch}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
