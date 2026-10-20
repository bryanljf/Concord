/**
 * Decides which remote publications to subscribe to (`autoSubscribe: false`, manual
 * subscription). Pure so it can be unit-tested; `hooks/useSubscriptions.ts` applies the plan.
 *
 * Streams are identified by their stream key (`lib/streamKey.ts`). Only what the user chose to
 * watch is subscribed:
 * - destaque with a screen share: that one at full quality with its audio, the other watched
 *   streams (mini tiles) at the lowest simulcast layer without audio;
 * - the grid, or a webcam in destaque: every watched stream at full quality (adaptive stream
 *   lowers the layer to the tile size) and the audio of every watched screen share;
 * - streams shown in another window (the pop-out, the cameras' picture-in-picture) and streams
 *   nobody picked stay unsubscribed.
 */
import { isCameraKey } from './streamKey';

export type VideoLayer = 'high' | 'low';

export interface StreamCandidate {
  /** Stream key: the participant id for a screen share, `<id>#camera` for a webcam. */
  key: string;
  hasVideo: boolean;
  /** Screen-share audio (a webcam never has any). */
  hasAudio: boolean;
}

export interface SubscriptionPlan {
  /** `high` for the stage/grid, `low` (lowest simulcast layer) for mini tiles, null = unsubscribed. */
  video: VideoLayer | null;
  audio: boolean;
}

export const UNSUBSCRIBED: SubscriptionPlan = { video: null, audio: false };

/**
 * @param focusedKey the stream in destaque (null = grid); it counts as watched even when it is
 *   missing from `watchedKeys` (the pop-out window only knows its one target).
 * @param watchedKeys every stream the user chose to watch, in any order.
 * @param elsewhereKeys streams another window of this app already shows: never subscribed here,
 *   so the video and the audio are not received (and heard) twice.
 */
export function planSubscriptions(
  streams: readonly StreamCandidate[],
  focusedKey: string | null,
  watchedKeys: Iterable<string> = [],
  elsewhereKeys: Iterable<string> = [],
): Map<string, SubscriptionPlan> {
  const watched = new Set(watchedKeys);
  if (focusedKey !== null) watched.add(focusedKey);
  const elsewhere = new Set(elsewhereKeys);
  // Only a screen share in destaque demotes the others; a webcam in destaque keeps them playing.
  const destaque = focusedKey !== null && !isCameraKey(focusedKey);
  const plan = new Map<string, SubscriptionPlan>();
  for (const stream of streams) {
    if (!stream.hasVideo || !watched.has(stream.key) || elsewhere.has(stream.key)) {
      plan.set(stream.key, UNSUBSCRIBED);
    } else if (!destaque || stream.key === focusedKey) {
      plan.set(stream.key, { video: 'high', audio: stream.hasAudio });
    } else {
      plan.set(stream.key, { video: 'low', audio: false });
    }
  }
  return plan;
}
