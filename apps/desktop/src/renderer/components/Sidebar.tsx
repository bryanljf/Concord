import type { KeyboardEvent } from 'react';
import type { PresenceSnapshot, RoomId } from '@concord/shared';
import { useNow } from '../hooks/useNow';
import { participantsOf } from '../lib/presence';
import { RoomItem } from './RoomItem';
import '../styles/sidebar.css';

interface SidebarProps {
  rooms: RoomId[];
  snapshot: PresenceSnapshot;
  currentRoom: RoomId | null;
  /**
   * Stream keys watched in the current room; a screen share's key is the participant id, so its
   * badge reads "assistindo" (camera keys never match a participant).
   */
  watchedIds: readonly string[];
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

export function Sidebar({
  rooms,
  snapshot,
  currentRoom,
  watchedIds,
  onJoin,
  onWatch,
}: SidebarProps) {
  const now = useNow();

  return (
    <nav className="sidebar" aria-label="Salas" onKeyDown={handleKeyDown}>
      <div className="sidebar__brand">CONCORD</div>
      <h2 className="sidebar__section">
        <span>Salas</span>
        <span aria-hidden="true">{rooms.length}</span>
      </h2>
      {rooms.length === 0 ? (
        <p className="sidebar__empty">
          Nenhuma sala disponível. Verifique a conexão com o servidor.
        </p>
      ) : (
        <ul className="sidebar__rooms">
          {rooms.map((room) => (
            <RoomItem
              key={room}
              room={room}
              participants={participantsOf(snapshot, room)}
              current={room === currentRoom}
              watchedIds={room === currentRoom ? watchedIds : NONE}
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
