/**
 * Which remote streams the user chose to watch in the current room session, and whether one of
 * them is in "destaque" (big on the stage) or they share the grid. Streams are identified by
 * their stream key (`lib/streamKey.ts`): the screen share is the participant id, the webcam is
 * `<id>#camera`. Entering a room watches nothing: every stream is a card without video until the
 * user picks "Assistir". Pure so the transitions can be unit-tested; `hooks/useRoom.ts` owns the
 * state and `lib/subscriptions.ts` turns it into livekit subscriptions.
 */
import { isCameraKey } from './streamKey';

export interface WatchingState {
  /** Watched stream keys, in the order the user picked them. */
  watched: readonly string[];
  /**
   * The watched stream in destaque; null = the grid (or, with a single watched stream, that one
   * big on the stage without a "Voltar à grade" button).
   */
  focused: string | null;
}

export const EMPTY_WATCHING: WatchingState = { watched: [], focused: null };

/** A new room session (join, switch, leave) starts with nothing watched. */
export function resetWatching(): WatchingState {
  return EMPTY_WATCHING;
}

function withWatched(state: WatchingState, key: string): readonly string[] {
  return state.watched.includes(key) ? state.watched : [...state.watched, key];
}

/**
 * "Assistir" on a card: adds the stream to the grid. In destaque the new stream also takes the
 * stage, except a webcam, which never steals the focus (it joins the strip as a mini tile).
 */
export function watch(state: WatchingState, key: string): WatchingState {
  const watched = withWatched(state, key);
  const focused = state.focused !== null && !isCameraKey(key) ? key : state.focused;
  if (watched === state.watched && focused === state.focused) return state;
  return { watched, focused };
}

/**
 * An explicit choice of one live (the sidebar "AO VIVO" badge, navigation from main): watches it
 * and puts it in destaque, whatever the current mode.
 */
export function watchAndFocus(state: WatchingState, key: string): WatchingState {
  const watched = withWatched(state, key);
  if (watched === state.watched && state.focused === key) return state;
  return { watched, focused: key };
}

/**
 * Puts a stream that is already watched in destaque (clicking a grid or mini tile). Never
 * watches anything new: keys outside the watched list leave the state unchanged.
 */
export function focusWatched(state: WatchingState, key: string): WatchingState {
  if (state.focused === key || !state.watched.includes(key)) return state;
  return { ...state, focused: key };
}

/** "Voltar à grade": leaves destaque; every watched stream shares the grid again. */
export function showGrid(state: WatchingState): WatchingState {
  return state.focused === null ? state : { ...state, focused: null };
}

/**
 * Removes several streams at once ("Parar de assistir", lives that ended). Removing the stream
 * in destaque goes back to the grid: the stage never hands the focus to another stream.
 */
function removeMany(state: WatchingState, removed: ReadonlySet<string>): WatchingState {
  if (!state.watched.some((key) => removed.has(key))) return state;
  const watched = state.watched.filter((key) => !removed.has(key));
  const focused = state.focused !== null && removed.has(state.focused) ? null : state.focused;
  return { watched, focused };
}

/** Stops watching `key` (video and audio are unsubscribed). */
export function unwatch(state: WatchingState, key: string): WatchingState {
  return removeMany(state, new Set([key]));
}

/**
 * Drops every watched stream that is no longer published (the person stopped streaming, turned
 * the camera off or left the room), like `unwatch`.
 */
export function pruneWatching(state: WatchingState, liveKeys: Iterable<string>): WatchingState {
  const live = new Set(liveKeys);
  return removeMany(state, new Set(state.watched.filter((key) => !live.has(key))));
}

/**
 * Watched lives that went off the air between two snapshots: `prevLiveWatched` were watched and
 * live before, `liveIds` are live now. Unwatching a live that is still on never counts.
 */
export function endedWatchedLives(
  prevLiveWatched: readonly string[],
  liveIds: ReadonlySet<string>,
): string[] {
  return prevLiveWatched.filter((id) => !liveIds.has(id));
}
