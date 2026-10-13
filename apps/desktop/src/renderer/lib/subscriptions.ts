/**
 * Decides which remote publications to subscribe to (SPEC 5.5: `autoSubscribe: false`, manual
 * subscription). Pure so it can be unit-tested; `hooks/useSubscriptions.ts` applies the plan.
 *
 * Only what the user chose to watch is subscribed: the focused live at full quality with its
 * audio, the other watched lives at the lowest simulcast layer without audio (mini tiles), and
 * every other live stays unsubscribed (a card without video on the stage).
 */

export type VideoLayer = 'high' | 'low';

export interface StreamCandidate {
  participantId: string;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface SubscriptionPlan {
  /** `high` for the stage, `low` (lowest simulcast layer) for mini tiles, null = unsubscribed. */
  video: VideoLayer | null;
  audio: boolean;
}

export const UNSUBSCRIBED: SubscriptionPlan = { video: null, audio: false };

/**
 * @param focusedId the live on the stage; it counts as watched even when it is missing from
 *   `watchedIds` (the pop-out window only knows its one target).
 * @param watchedIds every live the user chose to watch (mini tiles), in any order.
 */
export function planSubscriptions(
  streams: readonly StreamCandidate[],
  focusedId: string | null,
  watchedIds: Iterable<string> = [],
): Map<string, SubscriptionPlan> {
  const watched = new Set(watchedIds);
  const plan = new Map<string, SubscriptionPlan>();
  for (const stream of streams) {
    if (!stream.hasVideo) {
      plan.set(stream.participantId, UNSUBSCRIBED);
    } else if (stream.participantId === focusedId) {
      plan.set(stream.participantId, { video: 'high', audio: stream.hasAudio });
    } else if (watched.has(stream.participantId)) {
      plan.set(stream.participantId, { video: 'low', audio: false });
    } else {
      plan.set(stream.participantId, UNSUBSCRIBED);
    }
  }
  return plan;
}
