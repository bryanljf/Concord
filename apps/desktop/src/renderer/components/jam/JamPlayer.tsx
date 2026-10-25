import type { JamState, RoomId } from '@concord/shared';
import type { JamUploadStatus } from '../../../preload/api';
import type { JamActions } from '../../hooks/useJamActions';
import { jamArtworkSrc, jamItemStatusLabel, pausedByLabel, type JamPerson } from '../../lib/jam';
import type { Viewer } from '../../lib/viewers';
import type { VolumeSetting } from '../../lib/volume';
import { Avatar } from '../Avatar';
import { Spinner } from '../Spinner';
import { PauseIcon, PlayIcon, SkipForwardIcon } from '../icons';
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
 * The song playing in your room's Jam, like the music players: cover, title (bold), artists and
 * album (muted), who asked for it, the progress on the server's clock, "Ouvir" with your own
 * volume, and the controls everyone in the room has (pause or resume for everyone, skip) next to
 * who listens (overlapped avatars, like a live's viewers). Paused, it says who paused it. Before
 * the first song is ready it says so.
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
  const artists = track ? [track.artists, track.album].filter(Boolean).join(' · ') : '';

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
          {artists && <Marquee as="p" className="music-player__artist" text={artists} />}
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
        <div className="music-player__actions">{listenButton}</div>
      </div>
      {current && <JamProgress nowPlaying={current} clockOffsetMs={clockOffsetMs} />}
      {current && (
        <div className="jam-controls">
          {paused ? (
            <button
              type="button"
              className="btn btn--sm jam-controls__btn"
              disabled={toggling}
              title="Retomar a Jam para todos da sala"
              onClick={() => actions.resume(room)}
            >
              <PlayIcon size={14} />
              Retomar
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm jam-controls__btn"
              disabled={toggling}
              title="Pausar a Jam para todos da sala"
              onClick={() => actions.pause(room)}
            >
              <PauseIcon size={14} />
              Pausar
            </button>
          )}
          <button
            type="button"
            className="btn btn--sm jam-controls__btn"
            disabled={actions.busy.has(skipKey)}
            title="Pular para a próxima música (para todos da sala)"
            onClick={() => actions.skip(room, current.item.id)}
          >
            <SkipForwardIcon size={14} />
            Pular
          </button>
          <ViewerList
            viewers={listeners}
            kind="listening"
            tone="surface"
            placement="below"
            align="end"
            className="jam-controls__listeners"
          />
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
