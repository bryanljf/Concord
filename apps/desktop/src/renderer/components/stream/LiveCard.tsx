import { Avatar } from '../Avatar';
import { EyeIcon } from '../icons';

interface LiveCardProps {
  participantId: string;
  name: string;
  /** Discord avatar from presence; initials when missing. */
  avatarUrl: string | null;
  /** `stage`: big card in the grid; `strip`: same size as a mini tile. */
  size: 'stage' | 'strip';
  onWatch(): void;
}

/**
 * A live the user has not chosen to watch: no video, nothing subscribed. Avatar, name, the red
 * "AO VIVO" badge and an "Assistir" button that subscribes it and puts it on the stage.
 */
export function LiveCard({ participantId, name, avatarUrl, size, onWatch }: LiveCardProps) {
  const strip = size === 'strip';
  return (
    <article
      className={strip ? 'live-card live-card--strip' : 'live-card'}
      aria-label={`${name} está ao vivo`}
    >
      <span className="live-card__badge badge-live">AO VIVO</span>
      <Avatar id={participantId} name={name} src={avatarUrl} size={strip ? 'sm' : 'lg'} />
      <span className="live-card__name" title={name}>
        {name}
      </span>
      <button
        type="button"
        className={strip ? 'btn btn--primary btn--sm live-card__watch' : 'btn btn--primary'}
        aria-label={`Assistir a transmissão de ${name}`}
        onClick={onWatch}
      >
        <EyeIcon size={strip ? 14 : 18} />
        Assistir
      </button>
    </article>
  );
}
