/**
 * Seeking the Jam's song from its progress bar (only in the room): where a pointer or a key
 * lands, the position shown while the server catches up, and the requests, one at a time with the
 * latest winning. Pure so it can be unit-tested; `hooks/useJamSeek.ts` and
 * `components/music/MusicProgress.tsx` drive the bar with it.
 */
import { jamPositionAt, type JamNowPlaying } from '@concord/shared';
import { formatTrackTime } from './music';

/** ← / → (and ↓ / ↑) move this much. */
export const JAM_SEEK_STEP_MS = 5_000;

/** Page Down / Page Up move this much. */
export const JAM_SEEK_PAGE_STEP_MS = 30_000;

/** Keys pressed in a row (or held) go out as one seek once they rest this long. */
export const JAM_SEEK_KEY_DELAY_MS = 350;

/**
 * A server state this close to where the chosen position would be by now shows the seek (the
 * request's trip and the bot starting there account for the difference).
 */
export const JAM_SEEK_TOLERANCE_MS = 1_500;

/** Once the server took a seek, its position shows at most this long without a state showing it. */
export const JAM_SEEK_SETTLE_MS = 4_000;

/** The bar seeks only with a known duration. */
export function jamSeekable(durationMs: number): boolean {
  return Number.isFinite(durationMs) && durationMs > 0;
}

/** A whole number of milliseconds within the song (what `seekJam` accepts); 0 when unknown. */
export function clampSeekPosition(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !jamSeekable(durationMs)) return 0;
  return Math.min(Math.round(durationMs), Math.max(0, Math.round(positionMs)));
}

/** How far along a bar spanning `left`..`left + width` the pointer at `clientX` is (0–1). */
export function seekFraction(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(left) || !(width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - left) / width));
}

/** The position under the pointer: `fraction × duration`, rounded, within the song. */
export function seekPositionAt(
  clientX: number,
  bar: { left: number; width: number },
  durationMs: number,
): number {
  return clampSeekPosition(seekFraction(clientX, bar.left, bar.width) * durationMs, durationMs);
}

/**
 * Where a key moves the song from `positionMs`: ← / ↓ 5 s back, → / ↑ 5 s ahead, Page Down / Page
 * Up 30 s, Home the start, End the end; within the song. Null for any other key.
 */
export function seekKeyTarget(key: string, positionMs: number, durationMs: number): number | null {
  if (!jamSeekable(durationMs)) return null;
  let target: number;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      target = positionMs - JAM_SEEK_STEP_MS;
      break;
    case 'ArrowRight':
    case 'ArrowUp':
      target = positionMs + JAM_SEEK_STEP_MS;
      break;
    case 'PageDown':
      target = positionMs - JAM_SEEK_PAGE_STEP_MS;
      break;
    case 'PageUp':
      target = positionMs + JAM_SEEK_PAGE_STEP_MS;
      break;
    case 'Home':
      target = 0;
      break;
    case 'End':
      target = durationMs;
      break;
    default:
      return null;
  }
  return clampSeekPosition(target, durationMs);
}

/** "1:13 de 3:30" (the slider's `aria-valuetext`); just "1:13" without a known duration. */
export function seekValueText(positionMs: number, durationMs: number): string {
  const position = formatTrackTime(positionMs);
  return jamSeekable(durationMs) ? `${position} de ${formatTrackTime(durationMs)}` : position;
}

// --- Optimistic position --------------------------------------------------------------------

/** A position chosen on the bar that the server's state may not show yet. */
export interface JamSeekTarget {
  /** Tells the answers of successive seeks apart. */
  id: number;
  itemId: string;
  positionMs: number;
  /** Server clock when chosen: while the song plays, it moves on from there. */
  at: number;
  /** The server's state of the song when it was chosen: any other state is news from the server. */
  basis: JamNowPlaying;
  /** The server took it (`seekJam` resolved): from then on, its next state has the last word. */
  settled: boolean;
}

/** The song as the bar shows it while `target` stands: there, frozen while paused. */
export function jamSeekShown(nowPlaying: JamNowPlaying, target: JamSeekTarget): JamNowPlaying {
  return { ...nowPlaying, positionMs: target.positionMs, at: target.at };
}

function samePlayback(a: JamNowPlaying, b: JamNowPlaying): boolean {
  return (
    a.item.id === b.item.id &&
    a.positionMs === b.positionMs &&
    a.at === b.at &&
    a.paused === b.paused
  );
}

/**
 * Whether the bar still shows `target` given the server's latest state (`serverNow`: `Date.now()`
 * plus the clock offset). Once it does not, the bar follows the server again for good:
 * - another song plays: never;
 * - the state it was chosen on, still: yes (nothing new from the server yet);
 * - a newer state where the song is (within `JAM_SEEK_TOLERANCE_MS`) where the target would be by
 *   now: no, the server shows the seek;
 * - any other newer state: no once the server took the seek (its word wins: clamped, someone else
 *   seeked…); while the request is still on its way it is an older change (a song added, a
 *   pause…) and the target stands.
 */
export function jamSeekStands(
  target: JamSeekTarget,
  nowPlaying: JamNowPlaying,
  serverNow: number,
): boolean {
  if (nowPlaying.item.id !== target.itemId) return false;
  if (samePlayback(nowPlaying, target.basis)) return true;
  const expected = jamPositionAt(jamSeekShown(nowPlaying, target), serverNow);
  const actual = jamPositionAt(nowPlaying, serverNow);
  if (Math.abs(actual - expected) <= JAM_SEEK_TOLERANCE_MS) return false;
  return !target.settled;
}

// --- Requests ------------------------------------------------------------------------------

/**
 * How a seek went: `done` (the server took it), `failed` (refused: `onError` got why) or
 * `replaced` (a newer seek took its place before it went out).
 */
export type JamSeekOutcome = 'done' | 'failed' | 'replaced';

export interface JamSeekSender<T> {
  /** Sends `request` now, or once the one on its way is answered (replacing any that waited). */
  send(request: T): Promise<JamSeekOutcome>;
}

/**
 * Seeks one at a time, the latest winning: two requests on their way at once could reach the
 * server in either order, and a seek that waited is pointless once a newer one exists.
 */
export function createJamSeekSender<T>(
  deliver: (request: T) => Promise<void>,
  onError: (err: unknown) => void,
): JamSeekSender<T> {
  let busy = false;
  let waiting: { request: T; resolve: (outcome: JamSeekOutcome) => void } | null = null;

  const start = (request: T, resolve: (outcome: JamSeekOutcome) => void): void => {
    busy = true;
    // A missing bridge throws synchronously: still a failure, never a stuck queue.
    Promise.resolve()
      .then(() => deliver(request))
      .then(
        () => resolve('done'),
        (err: unknown) => {
          onError(err);
          resolve('failed');
        },
      )
      .finally(() => {
        busy = false;
        const next = waiting;
        waiting = null;
        if (next) start(next.request, next.resolve);
      });
  };

  return {
    send(request) {
      return new Promise<JamSeekOutcome>((resolve) => {
        if (!busy) {
          start(request, resolve);
          return;
        }
        waiting?.resolve('replaced');
        waiting = { request, resolve };
      });
    },
  };
}
