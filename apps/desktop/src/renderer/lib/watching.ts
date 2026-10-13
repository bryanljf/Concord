/**
 * Which remote lives the user chose to watch in the current room session, and which one of them
 * is on the stage. Entering a room watches nothing: every live is a card without video until the
 * user picks "Assistir". Pure so the transitions can be unit-tested; `hooks/useRoom.ts` owns the
 * state and `lib/subscriptions.ts` turns it into livekit subscriptions.
 */

export interface WatchingState {
  /** Watched participant ids, in the order the user picked them. */
  watched: readonly string[];
  /** The watched live on the stage (full quality + audio); null when nothing is watched. */
  focused: string | null;
}

export const EMPTY_WATCHING: WatchingState = { watched: [], focused: null };

/** A new room session (join, switch, leave) starts with nothing watched. */
export function resetWatching(): WatchingState {
  return EMPTY_WATCHING;
}

/**
 * Watches `id` and puts it on the stage. A previously focused live stays watched (it becomes a
 * mini tile); watching an already watched live only focuses it.
 */
export function watch(state: WatchingState, id: string): WatchingState {
  if (state.focused === id && state.watched.includes(id)) return state;
  const watched = state.watched.includes(id) ? state.watched : [...state.watched, id];
  return { watched, focused: id };
}

/**
 * Focuses a live that is already watched (clicking a mini tile). Never watches anything new:
 * ids outside the watched list leave the state unchanged.
 */
export function focusWatched(state: WatchingState, id: string): WatchingState {
  if (state.focused === id || !state.watched.includes(id)) return state;
  return { ...state, focused: id };
}

/**
 * The live that takes the stage when the focused one at `index` of `watched` goes away: the
 * next one in the list, otherwise the previous one, otherwise nothing.
 */
function handoverFocus(remaining: readonly string[], index: number): string | null {
  return remaining[index] ?? remaining[index - 1] ?? null;
}

/**
 * Removes several lives at once ("Parar de assistir", lives that ended). When the focused live
 * is removed the stage goes to the watched live that followed it (or preceded it, if it was the
 * last one); with nothing left the stage is empty.
 */
function removeMany(state: WatchingState, removed: ReadonlySet<string>): WatchingState {
  if (!state.watched.some((id) => removed.has(id))) return state;
  const watched = state.watched.filter((id) => !removed.has(id));
  const { focused } = state;
  if (focused === null || !removed.has(focused)) return { watched, focused };
  // Count the survivors before the focused one: that is where the next one now sits.
  const focusedIndex = state.watched.indexOf(focused);
  const before = state.watched.slice(0, focusedIndex).filter((id) => !removed.has(id)).length;
  return { watched, focused: handoverFocus(watched, before) };
}

/** Stops watching `id` (video and audio are unsubscribed), handing the stage over if needed. */
export function unwatch(state: WatchingState, id: string): WatchingState {
  return removeMany(state, new Set([id]));
}

/**
 * Drops every watched live that is no longer live (the person stopped streaming or left the
 * room), with the same focus handover as `unwatch`.
 */
export function pruneWatching(state: WatchingState, liveIds: Iterable<string>): WatchingState {
  const live = new Set(liveIds);
  return removeMany(state, new Set(state.watched.filter((id) => !live.has(id))));
}
