import type { PresenceParticipant, RoomId } from '@concord/shared';
import { formatJoinedAgo } from '../lib/format';
import { Avatar } from './Avatar';

interface ParticipantRowProps {
  room: RoomId;
  participant: PresenceParticipant;
  now: number;
  onWatch(room: RoomId, participantId: string): void;
}

export function ParticipantRow({ room, participant, now, onWatch }: ParticipantRowProps) {
  const className = participant.streaming ? 'participant participant--streaming' : 'participant';
  return (
    <li
      className={className}
      title={`${participant.name} — ${formatJoinedAgo(participant.joinedAt, now)}`}
    >
      <Avatar id={participant.id} name={participant.name} src={participant.avatarUrl} size="sm" />
      <span className="participant__name">{participant.name}</span>
      {participant.streaming && (
        <button
          type="button"
          className="participant__live"
          data-navitem
          aria-label={`Assistir ${participant.name} em #${room}`}
          title="Assistir"
          onClick={() => onWatch(room, participant.id)}
        >
          <span className="badge-live">AO VIVO</span>
        </button>
      )}
    </li>
  );
}
