import { useState } from 'react';
import type { JamRecentTrack } from '@concord/shared';
import { useNow } from '../../hooks/useNow';
import { jamArtworkSrc } from '../../lib/jam';
import { jamRecentEntries, jamRecentToggleTitle } from '../../lib/jamRecent';
import { Spinner } from '../Spinner';
import { PlusIcon } from '../icons';
import { Marquee } from '../music/Marquee';
import { MusicCover } from '../music/MusicCover';
import '../../styles/music.css';
import '../../styles/jam.css';
import '../../styles/jam-recent.css';

/** The column's id, for the button's `aria-controls`. */
const COLUMN_ID = 'jam-recent';

/** A clock with an arrow going back round it: the songs played lately (`icons.tsx`'s look). */
function HistoryIcon({ size }: { size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

export interface JamRecentButtonProps {
  /** The drawer is widened with the "Recentes" column. */
  open: boolean;
  onToggle(): void;
}

/**
 * "Recentes", left of "Adicionar música" in the drawer's Jam header; its owner renders it only
 * when the server has at least one song.
 */
export function JamRecentButton({ open, onToggle }: JamRecentButtonProps) {
  return (
    <button
      type="button"
      className="btn btn--sm jam-recent-button"
      aria-expanded={open}
      aria-controls={open ? COLUMN_ID : undefined}
      title={jamRecentToggleTitle()}
      onClick={onToggle}
    >
      <HistoryIcon size={14} />
      Recentes
    </button>
  );
}

interface JamRecentColumnProps {
  tracks: readonly JamRecentTrack[];
  /** Server clock minus this PC's (`useJam`), for "tocada há 5 min". */
  clockOffsetMs: number;
  /** Adds one to your room's Jam (toast, listening, errors: the owner's); settles when done. */
  onAdd(videoId: string): Promise<void>;
}

/**
 * "Recentes": the drawer's second column, with the songs the server still has (played in the last
 * 3 h), the most recent first, in a box like the player card that scrolls by itself, as tall as the
 * drawer's main column. One card per song: cover, title and artists sliding when too long, the
 * album, the duration and when it played, and "+" to add it (at once: the server has its audio).
 * It stays open, so several can be added one after another.
 */
export function JamRecentColumn({ tracks, clockOffsetMs, onAdd }: JamRecentColumnProps) {
  const now = useNow();
  const entries = jamRecentEntries(tracks, now, clockOffsetMs);
  // One at a time, so each toast knows whether the song starts right away or is queued.
  const [adding, setAdding] = useState<string | null>(null);

  function add(videoId: string): void {
    if (adding !== null) return;
    setAdding(videoId);
    void onAdd(videoId).finally(() => setAdding(null));
  }

  return (
    <section id={COLUMN_ID} className="jam-recent" aria-label="Recentes">
      {/* As tall as the Jam's header on the left, so the box lines up with the player card. */}
      <h3 className="music-drawer__heading jam-recent__heading" title={jamRecentToggleTitle()}>
        Recentes
        <span className="jam-queue__count">{entries.length}</span>
      </h3>
      <div className="jam-recent__frame">
        <ul className="jam-recent__box">
          {entries.map(({ track, meta, label }) => {
            const busy = adding === track.videoId;
            return (
              <li key={track.videoId} className="jam-recent-card">
                <MusicCover
                  artUrl={jamArtworkSrc(track.artworkUrl)}
                  playing={false}
                  listening={false}
                  size="sm"
                  remote
                />
                <div className="jam-recent-card__text">
                  <Marquee
                    as="p"
                    className="jam-recent-card__title"
                    text={track.title || 'Sem título'}
                  />
                  {track.artists && (
                    <Marquee as="p" className="jam-recent-card__artist" text={track.artists} />
                  )}
                  {track.album && (
                    <Marquee as="p" className="jam-recent-card__album" text={track.album} />
                  )}
                  <p className="jam-recent-card__meta">{meta}</p>
                </div>
                <button
                  type="button"
                  className="icon-btn jam-recent-card__add"
                  aria-label={label}
                  title="Adicionar à Jam"
                  disabled={adding !== null}
                  onClick={() => add(track.videoId)}
                >
                  {busy ? <Spinner size="sm" label="Adicionando" /> : <PlusIcon size={16} />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
