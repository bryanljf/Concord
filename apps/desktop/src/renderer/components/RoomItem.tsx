import { roomLabel, type JamState, type PresenceParticipant, type RoomId } from '@concord/shared';
import { pluralize } from '../lib/format';
import { jamIndicatorLabel, jamPlaying } from '../lib/jam';
import { ParticipantRow } from './ParticipantRow';
import { MusicButton } from './music/MusicButton';
import { SpeakerIcon } from './icons';

interface RoomItemProps {
  room: RoomId;
  participants: PresenceParticipant[];
  current: boolean;
  /** Lives watched in this room (only for the current room). */
  watchedIds: readonly string[];
  /** You listen to this room's Jam when above 0 (only the current room can have any). */
  musicListening: number;
  /** The room's Jam (something playing or queued); null without one, or without the Jam. */
  jam: JamState | null;
  /** The music drawer is open (every room's music button shows it). */
  musicOpen: boolean;
  onToggleMusic(): void;
  now: number;
  onJoin(room: RoomId): void;
  onWatch(room: RoomId, participantId: string): void;
}

export function RoomItem({
  room,
  participants,
  current,
  watchedIds,
  musicListening,
  jam,
  musicOpen,
  onToggleMusic,
  now,
  onJoin,
  onWatch,
}: RoomItemProps) {
  const count = participants.length;
  // While it has a Jam: the headphones with the playing bars, left of the people count.
  const jamLabel = jamIndicatorLabel(jam);
  const label = roomLabel(room);
  return (
    <li className="room">
      <div className="room__row">
        <button
          type="button"
          className={jamLabel !== null ? 'room__button room__button--music' : 'room__button'}
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
        {/* A sibling of the room button (no button inside a button), laid over its right end. */}
        {jamLabel !== null && (
          <span className="room__music">
            <MusicButton
              jamLabel={jamLabel}
              playing={jamPlaying(jam)}
              listening={musicListening > 0}
              open={musicOpen}
              onToggle={onToggleMusic}
            />
          </span>
        )}
      </div>
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
