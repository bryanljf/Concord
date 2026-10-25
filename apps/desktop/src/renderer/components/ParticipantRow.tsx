import { roomLabel, type PresenceParticipant, type RoomId } from '@concord/shared';
import { formatJoinedAgo } from '../lib/format';
import { Avatar } from './Avatar';
import { CameraIcon, PhoneIcon } from './icons';

interface ParticipantRowProps {
  room: RoomId;
  participant: PresenceParticipant;
  /** You are watching this live in the current room. */
  watching: boolean;
  now: number;
  onWatch(room: RoomId, participantId: string): void;
}

export function ParticipantRow({ room, participant, watching, now, onWatch }: ParticipantRowProps) {
  const className = participant.streaming ? 'participant participant--streaming' : 'participant';
  return (
    <li
      className={className}
      title={`${participant.name} — ${formatJoinedAgo(participant.joinedAt, now)}`}
    >
      <Avatar id={participant.id} name={participant.name} src={participant.avatarUrl} size="sm" />
      <span className="participant__name">{participant.name}</span>
      {participant.client === 'web' && (
        // Same look as the camera glyph (`participant__client` is there for its own style).
        <span
          className="participant__camera participant__client"
          role="img"
          aria-label="No celular"
          data-tooltip="No celular"
        >
          <PhoneIcon size={16} />
        </span>
      )}
      {participant.camera && (
        <span
          className="participant__camera"
          role="img"
          aria-label="Câmera ligada"
          data-tooltip="Câmera ligada"
        >
          <CameraIcon size={16} />
        </span>
      )}
      {participant.streaming && (
        <button
          type="button"
          className={
            watching ? 'participant__live participant__live--watching' : 'participant__live'
          }
          data-navitem
          aria-label={
            watching
              ? `Destacar ${participant.name}, que você já está assistindo`
              : `Assistir ${participant.name} em ${roomLabel(room)}`
          }
          title={watching ? 'Você está assistindo — clique para destacar' : 'Assistir'}
          onClick={() => onWatch(room, participant.id)}
        >
          <span className="badge-live">AO VIVO</span>
        </button>
      )}
    </li>
  );
}
