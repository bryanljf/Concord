import type { StreamKind } from '../../lib/streamKey';
import { Avatar } from '../Avatar';
import { EyeIcon } from '../icons';

interface LiveCardProps {
  participantId: string;
  name: string;
  /** Discord avatar from presence; initials when missing. */
  avatarUrl: string | null;
  /** A screen share ("AO VIVO") or a webcam ("CÂMERA"). */
  kind?: StreamKind;
  /** `stage`: big card in the grid; `strip`: same size as a mini tile. */
  size: 'stage' | 'strip';
  onWatch(): void;
}

/**
 * A stream the user has not chosen to watch: no video, nothing subscribed. Avatar, name, the red
 * "AO VIVO" badge (or "CÂMERA" for a webcam) and an "Assistir" button that subscribes it.
 */
export function LiveCard({
  participantId,
  name,
  avatarUrl,
  kind = 'screen',
  size,
  onWatch,
}: LiveCardProps) {
  const strip = size === 'strip';
  const camera = kind === 'camera';
  const title = camera ? `Câmera de ${name}` : name;
  return (
    <article
      className={strip ? 'live-card live-card--strip' : 'live-card'}
      aria-label={camera ? `${name} está com a câmera ligada` : `${name} está ao vivo`}
    >
      <span className={camera ? 'live-card__badge badge-camera' : 'live-card__badge badge-live'}>
        {camera ? 'CÂMERA' : 'AO VIVO'}
      </span>
      <Avatar id={participantId} name={name} src={avatarUrl} size={strip ? 'sm' : 'lg'} />
      <span className="live-card__name" title={title}>
        {title}
      </span>
      <button
        type="button"
        className={strip ? 'btn btn--primary btn--sm live-card__watch' : 'btn btn--primary'}
        aria-label={camera ? `Assistir a câmera de ${name}` : `Assistir a transmissão de ${name}`}
        onClick={onWatch}
      >
        <EyeIcon size={strip ? 14 : 18} />
        Assistir
      </button>
    </article>
  );
}
