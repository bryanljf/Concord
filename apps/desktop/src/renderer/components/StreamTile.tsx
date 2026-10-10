import type { PresenceParticipant } from '@telao/shared';
import { Avatar } from './Avatar';

interface StreamTileProps {
  participant: PresenceParticipant;
  focused?: boolean;
  /** When set, the tile is a button that brings this stream to the stage. */
  onSelect?: () => void;
}

/** Placeholder for a live stream; the real video arrives in Phase 3. */
export function StreamTile({ participant, focused = false, onSelect }: StreamTileProps) {
  const className = focused ? 'tile tile--focused' : 'tile';
  const body = (
    <>
      <span className="tile__badge badge-live">AO VIVO</span>
      <Avatar id={participant.id} name={participant.name} size={focused ? 'lg' : 'md'} />
      <span className="tile__name">{participant.name}</span>
      <span className="tile__note">
        {focused
          ? `${participant.name} está ao vivo — o vídeo chega na Fase 3`
          : 'Clique para destacar'}
      </span>
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={className}
        aria-label={`Destacar a transmissão de ${participant.name}`}
        onClick={onSelect}
      >
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
