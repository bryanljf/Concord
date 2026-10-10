import { useEffect } from 'react';
import { VideoQuality, type RemoteTrackPublication } from 'livekit-client';
import { planSubscriptions, type SubscriptionPlan } from '../lib/subscriptions';
import type { RemoteStream } from './useRemoteStreams';

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
 * Keeps livekit subscriptions in sync with what the UI shows (SPEC 5.5): the focused stream at
 * full quality with audio, the other mini tiles at the lowest simulcast layer, nothing else.
 */
export function useSubscriptions(
  streams: readonly RemoteStream[],
  focusedId: string | null,
  enabled = true,
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
    );
    for (const stream of streams) {
      const wanted = plan.get(stream.participantId) ?? { video: null, audio: false };
      if (stream.video) applyVideo(stream.video, wanted);
      if (stream.audio) applyAudio(stream.audio, wanted);
    }
  }, [streams, focusedId, enabled]);
}
