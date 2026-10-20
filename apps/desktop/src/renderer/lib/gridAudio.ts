/**
 * Whose screen-share audio plays when several watched lives could be heard at once (the grid,
 * or a webcam in destaque): only the latest one the user chose, either by clicking "Assistir"
 * or by putting it in destaque. The others start silenced, which is not a mute of the person's
 * volume setting: turning one up (volume or "Ativar som") lets it play as well, until the next
 * choice silences the others again. Pure so it can be unit-tested; `hooks/useRoom.ts` owns the
 * state and `hooks/useStreamAudio.ts` applies the silence.
 */
import { isCameraKey } from './streamKey';

export interface GridAudioState {
  /** Screen-share keys, latest explicit choice first ("Assistir", destaque, sidebar badge). */
  recent: readonly string[];
  /** Silenced streams the user turned up anyway since the latest choice. */
  unmuted: readonly string[];
}

export const EMPTY_GRID_AUDIO: GridAudioState = { recent: [], unmuted: [] };

/** A choice of `key` ("Assistir" or destaque): its audio plays, the others are silenced. */
export function chooseAudio(state: GridAudioState, key: string): GridAudioState {
  // A webcam has no audio: choosing one keeps whatever plays.
  if (isCameraKey(key)) return state;
  if (state.recent[0] === key && state.unmuted.length === 0) return state;
  return { recent: [key, ...state.recent.filter((recent) => recent !== key)], unmuted: [] };
}

/** The user turned a silenced stream up: it plays too, until the next choice. */
export function unmuteInGrid(state: GridAudioState, key: string): GridAudioState {
  if (state.unmuted.includes(key)) return state;
  return { ...state, unmuted: [...state.unmuted, key] };
}

/**
 * The screen share heard by default: the latest choice still watched. Should none be (they all
 * stopped), the latest watched screen share.
 */
export function audibleKey(state: GridAudioState, watchedKeys: readonly string[]): string | null {
  const watched = new Set(watchedKeys);
  const chosen = state.recent.find((key) => watched.has(key));
  if (chosen !== undefined) return chosen;
  return [...watchedKeys].reverse().find((key) => !isCameraKey(key)) ?? null;
}

/** Watched screen shares kept silent: all but the audible one and those turned up. */
export function silencedKeys(
  state: GridAudioState,
  watchedKeys: readonly string[],
): ReadonlySet<string> {
  const audible = audibleKey(state, watchedKeys);
  const unmuted = new Set(state.unmuted);
  return new Set(
    watchedKeys.filter((key) => !isCameraKey(key) && key !== audible && !unmuted.has(key)),
  );
}
