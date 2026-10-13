import { roomLabel, type PresenceParticipant, type RoomId } from '@concord/shared';
import { pluralize } from '../lib/format';
import { ParticipantRow } from './ParticipantRow';
import { SpeakerIcon } from './icons';

interface RoomItemProps {
  room: RoomId;
  participants: PresenceParticipant[];
  current: boolean;
  /** Lives watched in this room (only for the current room). */
  watchedIds: readonly string[];
  now: number;
  onJoin(room: RoomId): void;
  onWatch(room: RoomId, participantId: string): void;
}

export function RoomItem({
  room,
  participants,
  current,
  watchedIds,
  now,
  onJoin,
  onWatch,
}: RoomItemProps) {
  const count = participants.length;
  const label = roomLabel(room);
  return (
    <li className="room">
      <button
        type="button"
        className="room__button"
        data-navitem
        aria-current={current ? 'true' : undefined}
        title={current ? `Você está em ${label}` : `Entrar em ${label}`}
        onClick={() => onJoin(room)}
      >
        <SpeakerIcon size={18} />
        <span className="room__name">{label}</span>
        {count > 0 && (
          <span className="room__count" aria-label={pluralize(count, 'pessoa', 'pessoas')}>
            {count}
          </span>
        )}
      </button>
      {count > 0 && (
        <ul className="room__participants" aria-label={`Participantes de ${label}`}>
          {participants.map((participant) => (
            <ParticipantRow
              key={participant.id}
              room={room}
              participant={participant}
              watching={watchedIds.includes(participant.id)}
              now={now}
              onWatch={onWatch}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
