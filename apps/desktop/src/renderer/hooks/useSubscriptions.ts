import { useEffect } from 'react';
import { VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import { planSubscriptions, type SubscriptionPlan } from '../lib/subscriptions';
import type { RemoteStream } from './useRemoteStreams';

const NONE: readonly string[] = [];

function applyVideo(publication: RemoteTrackPublication, plan: SubscriptionPlan): void {
  if (plan.video === null) {
    if (publication.isDesired) publication.setSubscribed(false);
    return;
  }
  if (!publication.isDesired) publication.setSubscribed(true);
  // Caps the layer the server sends; adaptive stream may lower it further from the <video> size.
  publication.setVideoQuality(plan.video === 'high' ? VideoQuality.HIGH : VideoQuality.LOW);
}

function applyAudio(publication: RemoteTrackPublication, plan: SubscriptionPlan): void {
  if (publication.isDesired !== plan.audio) publication.setSubscribed(plan.audio);
}

/**
 * Keeps livekit subscriptions in sync with what the user chose to watch: the focused
 * live at full quality with audio, the other watched lives (mini tiles) at the lowest simulcast
 * layer without audio, nothing else. `watchedIds` defaults to none, so a caller that only knows
 * one target (the pop-out window) subscribes to just that one.
 */
export function useSubscriptions(
  streams: readonly RemoteStream[],
  focusedId: string | null,
  enabled = true,
  watchedIds: readonly string[] = NONE,
): void {
  useEffect(() => {
    if (!enabled) return;
    const plan = planSubscriptions(
      streams.map((stream) => ({
        participantId: stream.participantId,
        hasVideo: stream.video !== null,
        hasAudio: stream.audio !== null,
      })),
      focusedId,
      watchedIds,
    );
    for (const stream of streams) {
      const wanted = plan.get(stream.participantId) ?? { video: null, audio: false };
      if (stream.video) applyVideo(stream.video, wanted);
      if (stream.audio) applyAudio(stream.audio, wanted);
    }
  }, [streams, focusedId, watchedIds, enabled]);
}
