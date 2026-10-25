import { roomLabel, type JamState, type RoomId } from '@concord/shared';
import type { JamUploadStatus } from '../../../preload/api';
import { useJamActions } from '../../hooks/useJamActions';
import { jamArtworkSrc, jamTrackLine, type JamPerson } from '../../lib/jam';
import type { Viewer } from '../../lib/viewers';
import { Spinner } from '../Spinner';
import { PlusIcon } from '../icons';
import { Marquee } from '../music/Marquee';
import { MusicCover } from '../music/MusicCover';
import { JamPlayer, type JamListeningControls } from './JamPlayer';
import { JamQueue } from './JamQueue';
import '../../styles/jam.css';

interface JamRoomPanelProps {
  room: RoomId;
  state: JamState;
  clockOffsetMs: number;
  person(id: string): JamPerson;
  uploads: ReadonlyMap<string, JamUploadStatus>;
  listeners: readonly Viewer[];
  listening: JamListeningControls;
  /** "Adicionar música": the search dialog. */
  onOpenSearch(): void;
}

/**
 * Your room's Jam in the music drawer (only while connected to it): the song playing with its
 * controls, then "A seguir" with the queue, and "Adicionar música".
 */
export function JamRoomPanel({
  room,
  state,
  clockOffsetMs,
  person,
  uploads,
  listeners,
  listening,
  onOpenSearch,
}: JamRoomPanelProps) {
  const actions = useJamActions();
  return (
    <section className="music-drawer__section jam-panel" aria-label="Jam nesta sala">
      <div className="jam-panel__header">
        <h3 className="music-drawer__heading">Jam</h3>
        <button type="button" className="btn btn--sm jam-panel__add" onClick={onOpenSearch}>
          <PlusIcon size={14} />
          Adicionar música
        </button>
      </div>
      <JamPlayer
        room={room}
        state={state}
        clockOffsetMs={clockOffsetMs}
        person={person}
        uploads={uploads}
        listeners={listeners}
        listening={listening}
        actions={actions}
      />
      <JamQueue room={room} state={state} person={person} uploads={uploads} actions={actions} />
    </section>
  );
}

interface JamElsewhereItemProps {
  state: JamState;
  /** "Entrar e ouvir" is on its way. */
  pending: boolean;
  onListenIn(): void;
}

/**
 * A Jam in another room (or in yours while not connected), read-only: its cover, what it plays
 * and "Entrar e ouvir", which enters the room and listens once the Jam shows up there.
 */
export function JamElsewhereItem({ state, pending, onListenIn }: JamElsewhereItemProps) {
  const where = roomLabel(state.room);
  const track = state.current?.item.track ?? null;
  const line = track ? jamTrackLine(track) : 'Preparando a primeira música…';
  return (
    <li className="music-elsewhere">
      <MusicCover
        artUrl={jamArtworkSrc(track?.artworkUrl)}
        playing={false}
        listening={false}
        size="xs"
        remote
      />
      <div className="music-elsewhere__text">
        <p className="music-elsewhere__name" title={`Jam em ${where}`}>
          <strong>Jam</strong>
          <span className="music-elsewhere__room"> · {where}</span>
        </p>
        <Marquee
          as="p"
          className="music-elsewhere__hint"
          text={state.current?.paused ? `Pausada · ${line}` : line}
        />
      </div>
      <button
        type="button"
        className="btn btn--primary btn--sm"
        disabled={pending}
        aria-label={`Entrar em ${where} e ouvir a Jam`}
        onClick={onListenIn}
      >
        {pending ? <Spinner size="sm" label="Entrando" /> : 'Entrar e ouvir'}
      </button>
    </li>
  );
}
