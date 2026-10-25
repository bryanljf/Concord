import type { JamState, RoomId } from '@concord/shared';
import type { JamUploadStatus } from '../../../preload/api';
import type { JamActions } from '../../hooks/useJamActions';
import {
  jamArtworkSrc,
  jamItemStatusLabel,
  jamPreviousItem,
  jamPreviousTitle,
  pausedByLabel,
  type JamPerson,
} from '../../lib/jam';
import type { Viewer } from '../../lib/viewers';
import type { VolumeSetting } from '../../lib/volume';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from '../icons';
import { Marquee } from '../music/Marquee';
import { MusicCover, MusicVolume } from '../music/MusicCover';
import { JamProgress } from '../music/MusicProgress';
import { ViewerList } from '../stream/ViewerList';
import '../../styles/music.css';
import '../../styles/jam.css';

export interface JamListeningControls {
  /** You listen to the Jam ("Parar de ouvir", the equalizer and the volume). */
  on: boolean;
  /** "Ouvir" was pressed and the Jam's audio is on its way. */
  pending: boolean;
  setting: VolumeSetting;
  listen(): void;
  stop(): void;
  setVolume(volume: number): void;
  toggleMute(): void;
}

interface JamPlayerProps {
  room: RoomId;
  /** The room's Jam (something playing or queued). */
  state: JamState;
  clockOffsetMs: number;
  person(id: string): JamPerson;
  uploads: ReadonlyMap<string, JamUploadStatus>;
  /** Who listens to the Jam in the room (`concord.watching` `@jam#music`), you included. */
  listeners: readonly Viewer[];
  listening: JamListeningControls;
  actions: JamActions;
}

/**
 * The song playing in your room's Jam, like the music players: cover, title (bold), artists
 * (muted) with the album on its own line below, who asked for it, the progress on the server's
 * clock (a slider: anyone in the room can move the song), "Ouvir" with your own volume and, above
 * it in the card's top-right corner, who listens (small overlapped avatars, like a live's viewers),
 * then the icon controls everyone in the room has, centered under the bar (back to the previous
 * song once one was played, pause or resume for everyone, skip). Paused, it says who paused it.
 * Before the first song is ready it says so.
 */
export function JamPlayer({
  room,
  state,
  clockOffsetMs,
  person,
  uploads,
  listeners,
  listening,
  actions,
}: JamPlayerProps) {
  const current = state.current;
  const track = current?.item.track ?? null;
  const paused = current?.paused ?? false;
  const requester = current ? person(current.item.requestedBy) : null;
  const statusLabel = current
    ? jamItemStatusLabel(current.item, uploads.get(current.item.id))
    : null;
  const skipKey = current ? `skip:${current.item.id}` : '';
  const toggling = actions.busy.has('pause') || actions.busy.has('resume');
  // Only once a song was really played in this Jam.
  const previous = jamPreviousItem(state);

  const listenButton = listening.on ? (
    <button type="button" className="btn btn--sm" onClick={listening.stop}>
      Parar de ouvir
    </button>
  ) : (
    <button
      type="button"
      className="btn btn--primary btn--sm"
      disabled={listening.pending}
      aria-label="Ouvir a Jam"
      onClick={listening.listen}
    >
      {listening.pending ? <Spinner size="sm" label="Conectando" /> : 'Ouvir'}
    </button>
  );

  return (
    <article
      className={listening.on ? 'music-player music-player--listening' : 'music-player'}
      aria-label="Jam: tocando agora"
    >
      <div className="music-player__main">
        <MusicCover
          artUrl={jamArtworkSrc(track?.artworkUrl)}
          playing={current !== null && !paused}
          listening={listening.on}
          remote
        />
        <div className="music-player__text">
          <Marquee
            as="p"
            className="music-player__title"
            text={track?.title || (current ? 'Sem título' : 'Preparando a primeira música…')}
          />
          {track?.artists && (
            <Marquee as="p" className="music-player__artist" text={track.artists} />
          )}
          {track?.album && <Marquee as="p" className="music-player__album" text={track.album} />}
          <p className="music-player__source">
            {requester ? (
              <>
                <span className="jam-player__by">pedida por</span>
                <Avatar
                  id={requester.id}
                  name={requester.name}
                  src={requester.avatarUrl}
                  size="xs"
                />
                <span className="music-player__who">
                  {requester.self ? 'você' : requester.name}
                </span>
              </>
            ) : (
              <span>A Jam começa assim que a música chegar ao servidor.</span>
            )}
            {/* No "Pausado" badge here: "Pausada por …" below says it, and the badge pushed the
                requester's name out of this narrow line. */}
            {statusLabel && <span className="jam-badge">{statusLabel}</span>}
          </p>
        </div>
        {/* Who listens in the card's top-right corner, small, with "Ouvir" below it. */}
        <div className="music-player__actions jam-player__actions">
          <ViewerList
            viewers={listeners}
            kind="listening"
            tone="surface"
            placement="below"
            align="end"
            className="jam-player__listeners"
          />
          {listenButton}
        </div>
      </div>
      {current && (
        <JamProgress
          nowPlaying={current}
          clockOffsetMs={clockOffsetMs}
          onSeek={(itemId, positionMs) => actions.seek(room, itemId, positionMs)}
        />
      )}
      {(current || previous) && (
        <div className="jam-controls">
          {/* Always there (so the buttons stay centered), dimmed until a song was played before. */}
          <button
            type="button"
            className="icon-btn jam-controls__btn"
            aria-label="Música anterior"
            title={previous ? jamPreviousTitle(previous) : 'Nenhuma música anterior nesta Jam'}
            disabled={!previous || actions.busy.has('previous')}
            onClick={() => actions.previous(room, current?.item.id ?? null)}
          >
            <SkipBackIcon size={16} />
          </button>
          {current &&
            (paused ? (
              <button
                type="button"
                className="icon-btn jam-controls__btn"
                aria-label="Retomar a Jam"
                title="Retomar a Jam para todos da sala"
                disabled={toggling}
                onClick={() => actions.resume(room)}
              >
                <PlayIcon size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-btn jam-controls__btn"
                aria-label="Pausar a Jam"
                title="Pausar a Jam para todos da sala"
                disabled={toggling}
                onClick={() => actions.pause(room)}
              >
                <PauseIcon size={16} />
              </button>
            ))}
          {current && (
            <button
              type="button"
              className="icon-btn jam-controls__btn"
              aria-label="Pular a música"
              title="Pular para a próxima música (para todos da sala)"
              disabled={actions.busy.has(skipKey)}
              onClick={() => actions.skip(room, current.item.id)}
            >
              <SkipForwardIcon size={16} />
            </button>
          )}
        </div>
      )}
      {paused && current && (
        <p className="jam-player__paused-by" role="status">
          {pausedByLabel(current.pausedBy ? person(current.pausedBy) : null)}
        </p>
      )}
      {listening.on && (
        <MusicVolume
          who="Jam"
          of="da"
          setting={listening.setting}
          onVolume={listening.setVolume}
          onToggleMute={listening.toggleMute}
        />
      )}
    </article>
  );
}
