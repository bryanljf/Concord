import { useState, useSyncExternalStore, type CSSProperties } from 'react';
import type { NowPlaying } from '../../../preload/api';
import { formatTrackTime, steadyNowPlaying } from '../../lib/music';
import { musicProgress } from '../../lib/musicListening';
import '../../styles/music.css';

/** The bar moves in small steps; a matching CSS transition makes them look continuous. */
const TICK_MS = 250;

function subscribeTicks(onChange: () => void): () => void {
  const id = window.setInterval(onChange, TICK_MS);
  return () => window.clearInterval(id);
}

function subscribeNever(): () => void {
  return () => undefined;
}

/** Quantized so the snapshot is stable between ticks (required by useSyncExternalStore). */
function readClock(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

/** The clock, ticking only while the music plays (paused or stopped, the bar is frozen anyway). */
function useMusicClock(running: boolean): number {
  return useSyncExternalStore(running ? subscribeTicks : subscribeNever, readClock);
}

/**
 * The reading the bar follows: a new snapshot slightly behind the current anchor (a stale
 * position from the app, a small clock difference) keeps the anchor, so the bar never rolls back.
 */
function useSteadyNowPlaying(nowPlaying: NowPlaying): NowPlaying {
  const [seen, setSeen] = useState(nowPlaying);
  const [steady, setSteady] = useState(nowPlaying);
  if (seen !== nowPlaying) {
    setSeen(nowPlaying);
    setSteady(steadyNowPlaying(steady, nowPlaying));
  }
  return steady;
}

interface MusicProgressProps {
  nowPlaying: NowPlaying;
}

/** Elapsed time, the animated bar and the duration ("Anúncio" instead of the time for ads). */
export function MusicProgress({ nowPlaying: reading }: MusicProgressProps) {
  const nowPlaying = useSteadyNowPlaying(reading);
  const now = useMusicClock(nowPlaying.state === 'playing');
  const { positionMs, durationMs, fraction } = musicProgress(nowPlaying, now);
  const known = durationMs > 0;
  const style = { '--music-progress': fraction } as CSSProperties;
  return (
    <div className="music-progress">
      <span className="music-progress__time">
        {nowPlaying.ad ? (
          <span className="music-progress__ad">Anúncio</span>
        ) : (
          formatTrackTime(positionMs)
        )}
      </span>
      <div
        className="music-progress__track"
        role="progressbar"
        aria-label="Progresso da música"
        aria-valuemin={0}
        aria-valuemax={known ? Math.round(durationMs / 1000) : undefined}
        aria-valuenow={known ? Math.round(positionMs / 1000) : undefined}
        aria-valuetext={
          known
            ? `${formatTrackTime(positionMs)} de ${formatTrackTime(durationMs)}`
            : formatTrackTime(positionMs)
        }
        style={style}
      >
        <span
          className={
            nowPlaying.state === 'playing'
              ? 'music-progress__fill music-progress__fill--playing'
              : 'music-progress__fill'
          }
        />
      </div>
      <span className="music-progress__time music-progress__time--end">
        {known ? formatTrackTime(durationMs) : '–:––'}
      </span>
    </div>
  );
}
