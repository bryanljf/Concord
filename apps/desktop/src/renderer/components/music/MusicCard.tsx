import type { Viewer } from '../../lib/viewers';
import { HeadphonesIcon, MusicIcon } from '../icons';
import { ViewerList } from '../stream/ViewerList';
import { Marquee } from './Marquee';
import '../../styles/music.css';

/** The room's Jam as the stage shows it (like the cards of lives and cameras). */
export interface MusicCardItem {
  /** What "Ouvir" listens to: the jam bot (`JAM_BOT_IDENTITY`), never shown as a person. */
  participantId: string;
  /** Cover of the song playing (a link); a note when there is none. */
  artUrl: string | null;
  /** The song playing ("Get Lucky"), or that the first song is on its way. */
  title: string;
  /** Its artists ("Daft Punk"); null while unknown. */
  artists: string | null;
  /** You are listening to it. */
  listening: boolean;
}

interface MusicCardProps {
  item: MusicCardItem;
  /** `stage`: big card in the grid; `strip`: same size as a mini tile. */
  size: 'stage' | 'strip';
  /** Who listens to it (`concord.watching` `@jam#music`), you included. */
  listeners?: readonly Viewer[];
  onListen(): void;
  onStopListening(): void;
  /** Opens the music panel: a click anywhere on the card, and "Ouvir" too. */
  onOpen(): void;
}

const NO_LISTENERS: readonly Viewer[] = [];

/**
 * The room's Jam on the stage: the green "JAM" badge, the song's cover (or a note), "Jam", what it
 * plays and "Ouvir" / "Parar de ouvir". Nothing is downloaded until "Ouvir", like "Assistir" for
 * lives. Once someone listens, the corner opposite the badge shows who, with overlapped avatars
 * like a live's viewers (only the count on a strip card). A click anywhere on the card opens the
 * music panel (player, queue, volume); "Ouvir" listens and opens it; "Parar de ouvir" only stops.
 */
export function MusicCard({
  item,
  size,
  listeners = NO_LISTENERS,
  onListen,
  onStopListening,
  onOpen,
}: MusicCardProps) {
  const strip = size === 'strip';
  const classes = ['live-card', 'music-card-stage', strip ? 'live-card--strip' : '']
    .filter(Boolean)
    .join(' ');
  const coverClass = strip
    ? 'music-card-stage__cover music-card-stage__cover--strip'
    : 'music-card-stage__cover';
  return (
    // The whole card opens the panel; keyboard users reach the same panel from its buttons and the
    // room's headphone button, so the article itself stays a plain container.
    <article
      className={`${classes} music-card-stage--clickable`}
      aria-label="A Jam está tocando nesta sala"
      title="Abrir o painel da Jam"
      onClick={onOpen}
    >
      <span className="live-card__badge badge-music">JAM</span>
      {listeners.length > 0 &&
        (strip ? (
          <ViewerList
            viewers={listeners}
            variant="compact"
            kind="listening"
            tone="surface"
            className="music-card-stage__listeners music-card-stage__listeners--strip"
          />
        ) : (
          <ViewerList
            viewers={listeners}
            kind="listening"
            tone="surface"
            placement="below"
            align="end"
            className="music-card-stage__listeners"
          />
        ))}
      {item.artUrl ? (
        <img
          className={coverClass}
          src={item.artUrl}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className={`${coverClass} music-card-stage__cover--note`} aria-hidden="true">
          <MusicIcon size={strip ? 16 : 32} />
        </span>
      )}
      {/* The green "JAM" badge says what it is: the card names the song and its artists. */}
      <Marquee className="live-card__name music-card-stage__title" text={item.title} />
      {item.artists && !strip && (
        <Marquee className="music-card-stage__playing" text={item.artists} />
      )}
      {item.listening ? (
        <button
          type="button"
          className={strip ? 'btn btn--sm live-card__watch' : 'btn'}
          aria-label="Parar de ouvir a Jam"
          onClick={(event) => {
            // Only stops listening: never opens the panel.
            event.stopPropagation();
            onStopListening();
          }}
        >
          <HeadphonesIcon size={strip ? 14 : 18} />
          Parar de ouvir
        </button>
      ) : (
        <button
          type="button"
          className={strip ? 'btn btn--primary btn--sm live-card__watch' : 'btn btn--primary'}
          aria-label="Ouvir a Jam e abrir o painel"
          onClick={(event) => {
            event.stopPropagation();
            onListen();
            onOpen();
          }}
        >
          <HeadphonesIcon size={strip ? 14 : 18} />
          Ouvir
        </button>
      )}
    </article>
  );
}
