import type { NowPlaying } from '../../../preload/api';
import { Avatar } from '../Avatar';
import { HeadphonesIcon } from '../icons';
import { Marquee } from './Marquee';
import '../../styles/music.css';

/** A music broadcast in your room, as the stage shows it (like the cards of lives and cameras). */
export interface MusicCardItem {
  participantId: string;
  name: string;
  avatarUrl: string | null;
  /** Cover of what it plays (data URL); the avatar when there is none. */
  artUrl: string | null;
  nowPlaying: NowPlaying | null;
  /** You are listening to it. */
  listening: boolean;
}

interface MusicCardProps {
  item: MusicCardItem;
  /** `stage`: big card in the grid; `strip`: same size as a mini tile. */
  size: 'stage' | 'strip';
  onListen(): void;
  onStopListening(): void;
}

/** "Dusk Till Dawn · Bart Skils", "Anúncio", or nothing while it plays nothing. */
function playingLine(nowPlaying: NowPlaying | null): string | null {
  if (!nowPlaying) return null;
  if (nowPlaying.ad) return 'Anúncio';
  if (!nowPlaying.title) return null;
  return nowPlaying.artist ? `${nowPlaying.title} · ${nowPlaying.artist}` : nowPlaying.title;
}

/**
 * Someone's music on the stage: the green "MÚSICA" badge, the cover (or their avatar), "Música
 * de Fulano", what it plays and "Ouvir" (one music at a time) / "Parar de ouvir". Nothing is
 * downloaded until "Ouvir", like "Assistir" for lives.
 */
export function MusicCard({ item, size, onListen, onStopListening }: MusicCardProps) {
  const strip = size === 'strip';
  const title = `Música de ${item.name}`;
  const line = playingLine(item.nowPlaying);
  const classes = ['live-card', 'music-card-stage', strip ? 'live-card--strip' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <article className={classes} aria-label={`${item.name} está transmitindo música`}>
      <span className="live-card__badge badge-music">MÚSICA</span>
      {item.artUrl ? (
        <img
          className={
            strip
              ? 'music-card-stage__cover music-card-stage__cover--strip'
              : 'music-card-stage__cover'
          }
          src={item.artUrl}
          alt=""
          draggable={false}
        />
      ) : (
        <Avatar
          id={item.participantId}
          name={item.name}
          src={item.avatarUrl}
          size={strip ? 'sm' : 'lg'}
        />
      )}
      <span className="live-card__name" title={title}>
        {title}
      </span>
      {line && !strip && <Marquee className="music-card-stage__playing" text={line} />}
      {item.listening ? (
        <button
          type="button"
          className={strip ? 'btn btn--sm live-card__watch' : 'btn'}
          aria-label={`Parar de ouvir a música de ${item.name}`}
          onClick={onStopListening}
        >
          <HeadphonesIcon size={strip ? 14 : 18} />
          Parar de ouvir
        </button>
      ) : (
        <button
          type="button"
          className={strip ? 'btn btn--primary btn--sm live-card__watch' : 'btn btn--primary'}
          aria-label={`Ouvir a música de ${item.name}`}
          onClick={onListen}
        >
          <HeadphonesIcon size={strip ? 14 : 18} />
          Ouvir
        </button>
      )}
    </article>
  );
}
