import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import {
  roomLabel,
  type JamItem,
  type JamState,
  type JamTrack,
  type RoomId,
} from '@concord/shared';
import type { JamUploadStatus } from '../../../preload/api';
import { useJamActions } from '../../hooks/useJamActions';
import { useJamPrefetch } from '../../hooks/useJamPrefetch';
import { useJamSearch } from '../../hooks/useJamSearch';
import { concord, toErrorMessage } from '../../lib/concord';
import {
  JAM_RESULTS_SHOWN,
  jamArtworkSrc,
  jamDurationLabel,
  jamItemStatusLabel,
  jamPreviousItem,
  jamPreviousTitle,
  jamQueryHint,
  jamQueryIntent,
  jamQueuePreview,
  jamQueueSummary,
  jamRoomIdle,
  jamTrackDetail,
  jamTrackLine,
  pausedByLabel,
  type JamPerson,
} from '../../lib/jam';
import { Spinner } from '../Spinner';
import {
  CloseIcon,
  LinkIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from '../icons';
import { Marquee } from '../music/Marquee';
import { MusicCover } from '../music/MusicCover';
import { JamProgress } from '../music/MusicProgress';
import '../../styles/music.css';
import '../../styles/jam.css';

/** Songs of "A seguir" shown above the search (the drawer has the whole queue). */
const COMPACT_QUEUE = 3;

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

interface JamSearchModalProps {
  room: RoomId;
  /** Connected to the room: songs can be added (not while reconnecting). */
  connected: boolean;
  /** The room's Jam; null while nothing plays nor is queued. */
  state: JamState | null;
  clockOffsetMs: number;
  person(id: string): JamPerson;
  uploads: ReadonlyMap<string, JamUploadStatus>;
  /** The server took the song (`roomWasIdle`: it starts right away). The owner closes this. */
  onAdded(room: RoomId, item: JamItem, roomWasIdle: boolean): void;
  /** "Ver a fila completa": the Jam in the music drawer. */
  onOpenQueue(): void;
  /** The ×, Esc or a click outside. */
  onClose(): void;
}

/**
 * "Adicionar música": a dialog in the middle of the screen with the room's Jam on top (the song
 * playing with its controls, the next few songs) and the YouTube Music search below, at most
 * four results with cover, title, artists, album and duration. A YouTube / YouTube Music link is
 * added straight away. Picking a song adds it to the room's queue (it starts at once when nothing
 * plays); a refusal stays here, in pt-BR.
 */
export function JamSearchModal({
  room,
  connected,
  state,
  clockOffsetMs,
  person,
  uploads,
  onAdded,
  onOpenQueue,
  onClose,
}: JamSearchModalProps) {
  const titleId = useId();
  const inputId = useId();
  const hintId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const intent = jamQueryIntent(text);
  const search = useJamSearch(intent.kind === 'search' ? intent.query : null);
  const hint = jamQueryHint(intent);
  // A head start: main downloads the top result by itself; this asks for the one hovered or
  // focused, and for a pasted link as soon as it is recognized.
  const prefetch = useJamPrefetch();
  const linkId = intent.kind === 'link' ? intent.videoId : null;
  useEffect(() => {
    if (linkId) prefetch.now(linkId);
  }, [linkId, prefetch]);
  const results =
    search.status === 'searching' || search.status === 'done'
      ? search.results.slice(0, JAM_RESULTS_SHOWN)
      : [];
  const disabled = adding !== null || !connected;

  // Focus comes back to what opened it (the bottom bar's "Música", the drawer's button). Read
  // while rendering the first time: the search box takes the focus before any effect runs.
  const [opener] = useState(() => document.activeElement);
  useEffect(() => {
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected)
        opener.focus({ preventScroll: true });
    };
  }, [opener]);

  function add(videoId: string): void {
    if (adding !== null || !connected) return;
    const roomWasIdle = jamRoomIdle(state);
    setAdding(videoId);
    setAddError(null);
    Promise.resolve()
      .then(() => concord().addToJam(room, videoId))
      .then(
        (item) => onAdded(room, item, roomWasIdle),
        (err: unknown) => {
          setAdding(null);
          setAddError(toErrorMessage(err, 'Não foi possível adicionar a música.'));
        },
      );
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      // Handled here: the window's Esc (drawer, fullscreen…) must not also run.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    // Focus trap: Tab and Shift+Tab go round the dialog's controls.
    const items = [...dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  let status: string | null = null;
  if (search.status === 'done' && search.results.length === 0) {
    status = `Nenhuma música encontrada para “${search.query}”.`;
  }
  const error = addError ?? (search.status === 'error' ? search.message : null);

  return (
    <div
      className="jam-modal-backdrop"
      onMouseDown={(event) => {
        // Only a press on the backdrop itself (a drag that started inside never closes it).
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialog}
        className="jam-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="jam-modal__header">
          <span className="jam-modal__icon" aria-hidden="true">
            <MusicIcon size={18} />
          </span>
          <h2 id={titleId} className="jam-modal__title">
            Adicionar música
          </h2>
          <span className="jam-modal__room">
            Jam de <strong>{roomLabel(room)}</strong>
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Fechar"
            title="Fechar (Esc)"
            onClick={onClose}
          >
            <CloseIcon size={18} />
          </button>
        </header>

        {state && !jamRoomIdle(state) && (
          <JamCompact
            room={room}
            state={state}
            clockOffsetMs={clockOffsetMs}
            person={person}
            uploads={uploads}
            canControl={connected}
            onOpenQueue={onOpenQueue}
          />
        )}

        <div className="jam-search">
          <label htmlFor={inputId} className="sr-only">
            Buscar no YouTube Music
          </label>
          <div className="jam-search__field">
            <SearchIcon size={18} className="jam-search__icon" />
            <input
              id={inputId}
              className="input jam-search__input"
              type="search"
              placeholder="Busque uma música ou cole um link do YouTube"
              autoComplete="off"
              spellCheck={false}
              // The dialog exists to type here.
              autoFocus
              value={text}
              aria-describedby={hint ? hintId : undefined}
              onChange={(event) => {
                setText(event.target.value);
                setAddError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && intent.kind === 'link') add(intent.videoId);
              }}
            />
            {search.status === 'searching' && (
              <span className="jam-search__spinner">
                <Spinner size="sm" label="Buscando" />
              </span>
            )}
          </div>
          {hint && (
            <p id={hintId} className="jam-search__hint">
              {hint}
            </p>
          )}
          {!connected && (
            <p className="jam-search__hint" role="status">
              Reconectando à sala… Você poderá adicionar músicas em seguida.
            </p>
          )}
          {error && (
            <p className="jam-search__error" role="alert">
              {error}
            </p>
          )}

          {intent.kind === 'link' ? (
            <ul className="jam-results" aria-label="Link do YouTube">
              <li>
                <button
                  type="button"
                  className="jam-result"
                  disabled={disabled}
                  onClick={() => add(intent.videoId)}
                >
                  <span className="music-cover music-cover--sm" aria-hidden="true">
                    <LinkIcon size={18} />
                  </span>
                  <span className="jam-result__text">
                    <span className="jam-result__title">Adicionar link</span>
                    <span className="jam-result__detail">youtube.com/watch?v={intent.videoId}</span>
                  </span>
                  <ResultAction adding={adding === intent.videoId} />
                </button>
              </li>
            </ul>
          ) : (
            results.length > 0 && (
              <ul
                className={
                  search.status === 'searching' ? 'jam-results jam-results--stale' : 'jam-results'
                }
                aria-label="Resultados da busca"
                aria-busy={search.status === 'searching'}
              >
                {results.map((track) => (
                  <li key={track.videoId}>
                    <JamResult
                      track={track}
                      disabled={disabled}
                      adding={adding === track.videoId}
                      onAdd={() => add(track.videoId)}
                      onIntent={() => prefetch.intend(track.videoId)}
                      onLeave={() => prefetch.cancel(track.videoId)}
                    />
                  </li>
                ))}
              </ul>
            )
          )}
          {status && (
            <p className="jam-search__status" role="status">
              {status}
            </p>
          )}
          <p className="jam-search__note">
            A música vem do YouTube Music, sem anúncios, e toca para todos da sala.
          </p>
        </div>
      </div>
    </div>
  );
}

function ResultAction({ adding }: { adding: boolean }) {
  return (
    <span className="jam-result__action">
      {adding ? <Spinner size="sm" label="Adicionando" /> : <PlusIcon size={16} />}
      <span className="jam-result__action-label">{adding ? 'Adicionando…' : 'Adicionar'}</span>
    </span>
  );
}

interface JamResultProps {
  track: JamTrack;
  disabled: boolean;
  adding: boolean;
  onAdd(): void;
  /** Hovered or focused: its download may start ahead of time. */
  onIntent(): void;
  onLeave(): void;
}

/** One search result, like the music players: cover, title and artists sliding when too long. */
function JamResult({ track, disabled, adding, onAdd, onIntent, onLeave }: JamResultProps) {
  return (
    <button
      type="button"
      className={adding ? 'jam-result jam-result--adding' : 'jam-result'}
      disabled={disabled}
      aria-label={`Adicionar ${jamTrackLine(track)} (${jamTrackDetail(track)})`}
      onClick={onAdd}
      onMouseEnter={onIntent}
      onFocus={onIntent}
      onMouseLeave={onLeave}
      onBlur={onLeave}
    >
      <MusicCover
        artUrl={jamArtworkSrc(track.artworkUrl)}
        playing={false}
        listening={false}
        size="sm"
        remote
      />
      <span className="jam-result__text">
        <Marquee className="jam-result__title" text={track.title || 'Sem título'} />
        {track.artists && <Marquee className="jam-result__artist" text={track.artists} />}
        {/* The album below the artists (sliding when too long); the duration always shows. */}
        <span className="jam-result__detail">
          {track.album && (
            <>
              <Marquee className="jam-result__album" text={track.album} />
              <span aria-hidden="true">·</span>
            </>
          )}
          <span className="jam-result__duration">{jamDurationLabel(track.durationMs)}</span>
        </span>
      </span>
      <ResultAction adding={adding} />
    </button>
  );
}

interface JamCompactProps {
  room: RoomId;
  state: JamState;
  clockOffsetMs: number;
  person(id: string): JamPerson;
  uploads: ReadonlyMap<string, JamUploadStatus>;
  canControl: boolean;
  onOpenQueue(): void;
}

/**
 * The room's Jam above the search: the song playing (its bar seeks; back to the previous song once
 * one was played, pause, skip) and the next few songs.
 */
function JamCompact({
  room,
  state,
  clockOffsetMs,
  person,
  uploads,
  canControl,
  onOpenQueue,
}: JamCompactProps) {
  const actions = useJamActions();
  const current = state.current;
  const { shown, more } = jamQueuePreview(state.queue, COMPACT_QUEUE);
  const toggling = actions.busy.has('pause') || actions.busy.has('resume');
  const previous = jamPreviousItem(state);
  const label = current
    ? current.paused
      ? pausedByLabel(current.pausedBy ? person(current.pausedBy) : null)
      : 'Tocando agora'
    : 'Preparando a primeira música…';
  return (
    <section className="jam-compact" aria-label={`Jam de ${roomLabel(room)}`}>
      {current && (
        <div className="jam-compact__now">
          <MusicCover
            artUrl={jamArtworkSrc(current.item.track.artworkUrl)}
            playing={!current.paused}
            listening={false}
            size="xs"
            remote
          />
          <div className="jam-compact__text">
            <span className="jam-compact__label">{label}</span>
            <Marquee
              as="strong"
              className="jam-compact__title"
              text={jamTrackLine(current.item.track)}
            />
            <JamProgress
              nowPlaying={current}
              clockOffsetMs={clockOffsetMs}
              compact
              onSeek={
                canControl
                  ? (itemId, positionMs) => actions.seek(room, itemId, positionMs)
                  : undefined
              }
            />
          </div>
          {canControl && (
            <div className="jam-compact__controls">
              <button
                type="button"
                className="icon-btn"
                aria-label="Música anterior"
                title={previous ? jamPreviousTitle(previous) : 'Nenhuma música anterior nesta Jam'}
                disabled={!previous || actions.busy.has('previous')}
                onClick={() => actions.previous(room, current.item.id)}
              >
                <SkipBackIcon size={16} />
              </button>
              {current.paused ? (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Retomar a Jam"
                  title="Retomar para todos"
                  disabled={toggling}
                  onClick={() => actions.resume(room)}
                >
                  <PlayIcon size={16} />
                </button>
              ) : (
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Pausar a Jam"
                  title="Pausar para todos"
                  disabled={toggling}
                  onClick={() => actions.pause(room)}
                >
                  <PauseIcon size={16} />
                </button>
              )}
              <button
                type="button"
                className="icon-btn"
                aria-label="Pular a música"
                title="Pular para a próxima"
                disabled={actions.busy.has(`skip:${current.item.id}`)}
                onClick={() => actions.skip(room, current.item.id)}
              >
                <SkipForwardIcon size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="jam-compact__queue-header">
        <span className="jam-compact__label">
          {current ? `A seguir · ${jamQueueSummary(state.queue.length)}` : label}
        </span>
        <button type="button" className="btn btn--link jam-compact__open" onClick={onOpenQueue}>
          Ver a fila completa
        </button>
      </div>
      {shown.length > 0 && (
        <ol className="jam-compact__queue">
          {shown.map((item) => {
            const statusLabel = jamItemStatusLabel(item, uploads.get(item.id));
            return (
              <li key={item.id} className="jam-compact__item">
                <Marquee className="jam-compact__item-title" text={jamTrackLine(item.track)} />
                {statusLabel && <span className="jam-badge">{statusLabel}</span>}
                <span className="jam-compact__duration">
                  {jamDurationLabel(item.track.durationMs)}
                </span>
              </li>
            );
          })}
          {more > 0 && (
            <li className="jam-compact__more">
              {more === 1 ? 'e mais 1 música' : `e mais ${more} músicas`}
            </li>
          )}
        </ol>
      )}
    </section>
  );
}
