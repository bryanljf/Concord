import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { JamNowPlaying } from '@concord/shared';
import { useJamSeek, type JamSeek, type JamSeekRequest } from '../../hooks/useJamSeek';
import { jamProgress } from '../../lib/jam';
import {
  jamSeekable,
  seekFraction,
  seekKeyTarget,
  seekPositionAt,
  seekValueText,
} from '../../lib/jamSeek';
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

/** The pointer holding the bar. */
interface Grab {
  pointerId: number;
  element: HTMLElement;
  /** The song it was grabbed on: let go on another one, it seeks nothing. */
  itemId: string;
}

interface TrackProgressProps {
  progress: Progress;
  playing: boolean;
  /** A thinner bar without the times' column widths (compact rows). */
  compact?: boolean;
  /** Seeking (in the room, with a known duration); without it the bar only shows the progress. */
  seek?: JamSeek;
  /** The song shown: a drag that started on another song is dropped. */
  itemId?: string;
}

/**
 * Elapsed time, the animated bar and the duration. Seekable, it is a slider: hovering thickens it
 * and shows the volume's round thumb (smaller) and the time under the pointer; a click or a drag
 * (shown as it goes, sent when let go; Esc gives up) moves the song for everyone, and so do the
 * keys (← / → 5 s, Page Up / Page Down 30 s, Home / End).
 */
export function TrackProgress({
  progress,
  playing,
  compact = false,
  seek,
  itemId = '',
}: TrackProgressProps) {
  const { durationMs } = progress;
  const known = durationMs > 0;
  const seeking = seek !== undefined && known;
  // Where a drag holds the song (shown instead of where it plays), and where the pointer hovers.
  const [drag, setDrag] = useState<{ itemId: string; positionMs: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const grab = useRef<Grab | null>(null);

  const dragMs = seeking && drag !== null && drag.itemId === itemId ? drag.positionMs : null;
  const positionMs = dragMs ?? progress.positionMs;
  const fraction = dragMs !== null ? dragMs / durationMs : progress.fraction;
  const dragging = dragMs !== null;

  const release = useCallback((): Grab | null => {
    const held = grab.current;
    grab.current = null;
    setDrag(null);
    return held;
  }, []);

  /** Gives up the drag without seeking (Esc, a cancelled pointer). */
  const cancelDrag = useCallback(() => {
    const held = release();
    if (held?.element.hasPointerCapture(held.pointerId)) {
      held.element.releasePointerCapture(held.pointerId);
    }
  }, [release]);

  // Esc while dragging gives up the drag, and only that: not the dialog, the drawer, fullscreen.
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [dragging, cancelDrag]);

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!seek || !known || event.button !== 0) return;
    // A drag the bar lost track of, and a key seek not sent yet: this one replaces them.
    cancelDrag();
    seek.cancelSoon();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    grab.current = { pointerId: event.pointerId, element, itemId };
    const rect = element.getBoundingClientRect();
    setDrag({ itemId, positionMs: seekPositionAt(event.clientX, rect, durationMs) });
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    if (!known) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHover(seekFraction(event.clientX, rect.left, rect.width));
    const held = grab.current;
    if (held && held.pointerId === event.pointerId) {
      setDrag({ itemId: held.itemId, positionMs: seekPositionAt(event.clientX, rect, durationMs) });
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (grab.current?.pointerId !== event.pointerId) return;
    const held = release();
    // The song changed, or the bar stopped seeking (left the room), while it was held.
    if (!held || !seek || !known || held.itemId !== itemId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    seek.seekNow(seekPositionAt(event.clientX, rect, durationMs));
  }

  function onPointerCancel(event: ReactPointerEvent<HTMLDivElement>): void {
    if (grab.current?.pointerId === event.pointerId) cancelDrag();
  }

  // After a pointerup the drag is already over; otherwise the bar lost the pointer: no seek.
  function onLostPointerCapture(event: ReactPointerEvent<HTMLDivElement>): void {
    if (grab.current?.pointerId === event.pointerId) release();
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!seek || !known || grab.current) return;
    if (event.key === 'Escape') {
      // Only a key seek still waiting to go out; otherwise Esc does what it always does.
      if (seek.cancelSoon()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = seekKeyTarget(event.key, positionMs, durationMs);
    if (target === null) return;
    // The arrows, Home, End and the page keys would scroll the drawer too.
    event.preventDefault();
    seek.seekSoon(target);
  }

  const style = { '--music-progress': fraction } as CSSProperties;
  const barClasses = [
    'music-progress__bar',
    seeking ? 'music-progress__bar--seekable' : '',
    dragging ? 'music-progress__bar--dragging' : '',
    // Glides between the clock's ticks; a drag follows the pointer at once.
    playing && !dragging ? 'music-progress__bar--playing' : '',
  ]
    .filter(Boolean)
    .join(' ');
  // The time under the pointer; while dragging, where the song will go.
  const tip = seeking ? (dragging ? fraction : hover) : null;

  return (
    <div className={compact ? 'music-progress music-progress--compact' : 'music-progress'}>
      <span className="music-progress__time">{formatTrackTime(positionMs)}</span>
      <div
        className={barClasses}
        role={seeking ? 'slider' : 'progressbar'}
        tabIndex={seeking ? 0 : undefined}
        aria-label={seeking ? 'Posição da música' : 'Progresso da música'}
        aria-valuemin={0}
        aria-valuemax={known ? Math.floor(durationMs / 1000) : undefined}
        aria-valuenow={known ? Math.floor(positionMs / 1000) : undefined}
        aria-valuetext={seekValueText(positionMs, durationMs)}
        style={style}
        onPointerDown={seeking ? onPointerDown : undefined}
        onPointerMove={seeking ? onPointerMove : undefined}
        onPointerLeave={() => setHover(null)}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
        onKeyDown={seeking ? onKeyDown : undefined}
      >
        <span className="music-progress__track">
          <span className="music-progress__fill" />
        </span>
        {seeking && (
          <span className="music-progress__head">
            <span className="music-progress__thumb" />
          </span>
        )}
        {tip !== null && (
          <span
            className="music-progress__tip"
            style={{ left: `${tip * 100}%` }}
            aria-hidden="true"
          >
            {formatTrackTime(tip * durationMs)}
          </span>
        )}
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
  /**
   * In the room (where the controls work): the bar seeks through it (`useJamActions().seek`).
   * Without it, or without a known duration, the bar only shows the progress.
   */
  onSeek?: JamSeekRequest;
}

/**
 * The Jam's song: from the server's state, on the server's clock (frozen while paused); a seek
 * shows at once and the bar follows the server again once its state shows it.
 */
export function JamProgress({
  nowPlaying,
  clockOffsetMs,
  compact = false,
  onSeek,
}: JamProgressProps) {
  const playing = !nowPlaying.paused;
  const now = useMusicClock(playing);
  const serverNow = now + clockOffsetMs;
  const seekable = onSeek !== undefined && jamSeekable(nowPlaying.item.track.durationMs);
  const seek = useJamSeek(nowPlaying, clockOffsetMs, serverNow, seekable ? onSeek : undefined);
  return (
    <TrackProgress
      progress={jamProgress(seek.shown, serverNow)}
      playing={playing}
      compact={compact}
      seek={seekable ? seek : undefined}
      itemId={nowPlaying.item.id}
    />
  );
}
