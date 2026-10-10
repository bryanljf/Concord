/**
 * Decides which remote publications to subscribe to (SPEC 5.5: `autoSubscribe: false`, manual
 * subscription). Pure so it can be unit-tested; `hooks/useSubscriptions.ts` applies the plan.
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

export interface PlanOptions {
  /** How many non-focused streams get a low-quality preview (default: all of them). */
  maxPreviews?: number;
}

/**
 * The focused participant gets video at full quality plus audio; the others get only the low
 * simulcast layer for their mini tile. Candidates without video are never subscribed.
 */
export function planSubscriptions(
  streams: readonly StreamCandidate[],
  focusedId: string | null,
  options: PlanOptions = {},
): Map<string, SubscriptionPlan> {
  const maxPreviews = options.maxPreviews ?? Number.POSITIVE_INFINITY;
  const plan = new Map<string, SubscriptionPlan>();
  let previews = 0;
  for (const stream of streams) {
    if (!stream.hasVideo) {
      plan.set(stream.participantId, UNSUBSCRIBED);
      continue;
    }
    if (stream.participantId === focusedId) {
      plan.set(stream.participantId, { video: 'high', audio: stream.hasAudio });
      continue;
    }
    if (previews < maxPreviews) {
      previews += 1;
      plan.set(stream.participantId, { video: 'low', audio: false });
    } else {
      plan.set(stream.participantId, UNSUBSCRIBED);
    }
  }
  return plan;
}

/**
 * Picks the stream to show on the stage: the requested one when it exists, otherwise the first
 * one, otherwise nothing.
 */
export function pickFocused(
  streams: readonly { participantId: string }[],
  requested: string | null,
): string | null {
  if (requested && streams.some((stream) => stream.participantId === requested)) return requested;
  return streams[0]?.participantId ?? null;
}
