import { roomLabel, type RoomId } from '@concord/shared';
import type { RoomConnectionState } from '../hooks/useRoom';
import { LeaveRoomIcon } from './icons';
import '../styles/room-status-panel.css';

interface RoomStatusPanelProps {
  room: RoomId;
  connectionState: RoomConnectionState;
  /** Joining failed or the room dropped (the stage offers "Tentar de novo"). */
  failed: boolean;
  onLeave(): void;
}

type Tone = 'online' | 'pending' | 'error';

const FAILED: { label: string; tone: Tone } = { label: 'Sem conexão com a sala', tone: 'error' };

const STATUS: Record<RoomConnectionState, { label: string; tone: Tone }> = {
  connected: { label: 'Conectado à sala', tone: 'online' },
  connecting: { label: 'Conectando…', tone: 'pending' },
  reconnecting: { label: 'Reconectando…', tone: 'pending' },
  // Shown while a join is starting over (e.g. right after an error retry).
  disconnected: { label: 'Conectando…', tone: 'pending' },
};

/**
 * The strip above the user panel while you are in a room (like Discord's "voice connected"):
 * connection status, the room, and the button to leave it.
 */
export function RoomStatusPanel({ room, connectionState, failed, onLeave }: RoomStatusPanelProps) {
  const status = failed ? FAILED : STATUS[connectionState];
  const label = roomLabel(room);
  return (
    <section className="room-status" aria-label={`Sala atual: ${label}`}>
      <div className="room-status__info" role="status">
        <span className={`room-status__state room-status__state--${status.tone}`}>
          {status.label}
        </span>
        <span className="room-status__room" title={label}>
          {label}
        </span>
      </div>
      <button
        type="button"
        className="icon-btn room-status__leave"
        aria-label="Sair da sala"
        data-tooltip="Sair da sala"
        onClick={onLeave}
      >
        <LeaveRoomIcon size={20} />
      </button>
    </section>
  );
}
