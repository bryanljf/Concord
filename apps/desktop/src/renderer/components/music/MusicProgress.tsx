import { useSyncExternalStore, type CSSProperties } from 'react';
import type { JamNowPlaying } from '@concord/shared';
import { jamProgress } from '../../lib/jam';
import { formatTrackTime } from '../../lib/music';
import type { MusicProgress as Progress } from '../../lib/musicListening';
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

/** The clock, ticking only while the music plays (paused, the bar is frozen anyway). */
function useMusicClock(running: boolean): number {
  return useSyncExternalStore(running ? subscribeTicks : subscribeNever, readClock);
}

interface TrackProgressProps {
  progress: Progress;
  playing: boolean;
  /** A thinner bar without the times' column widths (compact rows). */
  compact?: boolean;
}

/** Elapsed time, the animated bar and the duration. */
export function TrackProgress({ progress, playing, compact = false }: TrackProgressProps) {
  const { positionMs, durationMs, fraction } = progress;
  const known = durationMs > 0;
  const style = { '--music-progress': fraction } as CSSProperties;
  return (
    <div className={compact ? 'music-progress music-progress--compact' : 'music-progress'}>
      <span className="music-progress__time">{formatTrackTime(positionMs)}</span>
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
            playing ? 'music-progress__fill music-progress__fill--playing' : 'music-progress__fill'
          }
        />
      </div>
      <span className="music-progress__time music-progress__time--end">
        {known ? formatTrackTime(durationMs) : '–:––'}
      </span>
    </div>
  );
}

interface JamProgressProps {
  nowPlaying: JamNowPlaying;
  /** `useJam().clockOffsetMs`: the server's clock is what the Jam's positions are measured in. */
  clockOffsetMs: number;
  compact?: boolean;
}

/** The Jam's song: from the server's state, on the server's clock (frozen while paused). */
export function JamProgress({ nowPlaying, clockOffsetMs, compact = false }: JamProgressProps) {
  const playing = !nowPlaying.paused;
  const now = useMusicClock(playing);
  return (
    <TrackProgress
      progress={jamProgress(nowPlaying, now + clockOffsetMs)}
      playing={playing}
      compact={compact}
    />
  );
}
