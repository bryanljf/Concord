import type { PresenceParticipant, RoomId } from '@concord/shared';
import { pluralize } from '../lib/format';
import { ParticipantRow } from './ParticipantRow';
import { SpeakerIcon } from './icons';

interface RoomItemProps {
  room: RoomId;
  participants: PresenceParticipant[];
  current: boolean;
  now: number;
  onJoin(room: RoomId): void;
  onWatch(room: RoomId, participantId: string): void;
}

export function RoomItem({ room, participants, current, now, onJoin, onWatch }: RoomItemProps) {
  const count = participants.length;
  return (
    <li className="room">
      <button
        type="button"
        className="room__button"
        data-navitem
        aria-current={current ? 'true' : undefined}
        title={current ? `Você está em #${room}` : `Entrar em #${room}`}
        onClick={() => onJoin(room)}
      >
        <SpeakerIcon size={18} />
        <span className="room__name">{room}</span>
        {count > 0 && (
          <span className="room__count" aria-label={pluralize(count, 'pessoa', 'pessoas')}>
            {count}
          </span>
        )}
      </button>
      {count > 0 && (
        <ul className="room__participants" aria-label={`Participantes de #${room}`}>
          {participants.map((participant) => (
            <ParticipantRow
              key={participant.id}
              room={room}
              participant={participant}
              now={now}
              onWatch={onWatch}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
