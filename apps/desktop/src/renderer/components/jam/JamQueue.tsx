import type { JamState, RoomId } from '@concord/shared';
import type { JamUploadStatus } from '../../../preload/api';
import type { JamActions } from '../../hooks/useJamActions';
import {
  jamArtworkSrc,
  jamDurationLabel,
  jamEmptyQueueText,
  jamQueueEntries,
  requestedByLabel,
  type JamPerson,
} from '../../lib/jam';
import { Avatar } from '../Avatar';
import { CloseIcon } from '../icons';
import { Marquee } from '../music/Marquee';
import { MusicCover } from '../music/MusicCover';
import '../../styles/jam.css';

interface JamQueueProps {
  room: RoomId;
  state: JamState;
  person(id: string): JamPerson;
  uploads: ReadonlyMap<string, JamUploadStatus>;
  actions: JamActions;
}

/**
 * "A seguir": the upcoming songs in play order, each with its cover, title and artists (sliding
 * when too long, like the search results), duration, who asked for it, "Baixando…" while its audio
 * is on its way, and × to take it off the queue (anyone in the room can).
 */
export function JamQueue({ room, state, person, uploads, actions }: JamQueueProps) {
  const entries = jamQueueEntries(state.queue, uploads, person);
  return (
    <section className="jam-queue" aria-label="A seguir">
      <h3 className="music-drawer__heading jam-queue__heading">
        A seguir
        {entries.length > 0 && <span className="jam-queue__count">{entries.length}</span>}
      </h3>
      {entries.length === 0 ? (
        <p className="jam-queue__empty">{jamEmptyQueueText(state.current !== null)}</p>
      ) : (
        <ol className="jam-queue__list">
          {entries.map(({ item, position, requester, statusLabel }) => {
            const { track } = item;
            return (
              <li key={item.id} className="jam-queue__item">
                <span className="jam-queue__position" aria-hidden="true">
                  {position}
                </span>
                <MusicCover
                  artUrl={jamArtworkSrc(track.artworkUrl)}
                  playing={false}
                  listening={false}
                  size="xs"
                  remote
                />
                <div className="jam-queue__text">
                  <Marquee as="p" className="jam-queue__title" text={track.title || 'Sem título'} />
                  <p className="jam-queue__artist">
                    {statusLabel && <span className="jam-badge">{statusLabel}</span>}
                    {track.artists && (
                      <Marquee className="jam-queue__artists" text={track.artists} />
                    )}
                  </p>
                </div>
                <span className="jam-queue__duration">{jamDurationLabel(track.durationMs)}</span>
                <span className="jam-queue__requester" title={requestedByLabel(requester)}>
                  <Avatar
                    id={requester.id}
                    name={requester.name}
                    src={requester.avatarUrl}
                    size="xs"
                  />
                  <span className="sr-only">{requestedByLabel(requester)}</span>
                </span>
                <button
                  type="button"
                  className="icon-btn jam-queue__remove"
                  aria-label={`Tirar “${track.title}” da fila`}
                  title="Tirar da fila"
                  disabled={actions.busy.has(`remove:${item.id}`)}
                  onClick={() => actions.remove(room, item.id)}
                >
                  <CloseIcon size={14} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
