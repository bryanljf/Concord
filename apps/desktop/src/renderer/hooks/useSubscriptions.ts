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
 * Keeps livekit subscriptions in sync with what the user chose to watch (by stream key, see
 * `lib/subscriptions.ts`): a screen share in destaque at full quality with audio and the other
 * watched streams at the lowest layer; on the grid (or with a webcam in destaque) every watched
 * stream at full quality with the audio of every screen share; nothing else. `watchedKeys`
 * defaults to none, so a caller that only knows one target (the pop-out window) subscribes to
 * just that one; `elsewhereKeys` are shown by another window and never subscribed here.
 */
export function useSubscriptions(
  streams: readonly RemoteStream[],
  focusedKey: string | null,
  enabled = true,
  watchedKeys: readonly string[] = NONE,
  elsewhereKeys: readonly string[] = NONE,
): void {
  useEffect(() => {
    if (!enabled) return;
    const plan = planSubscriptions(
      streams.map((stream) => ({
        key: stream.key,
        hasVideo: stream.video !== null,
        hasAudio: stream.audio !== null,
      })),
      focusedKey,
      watchedKeys,
      elsewhereKeys,
    );
    for (const stream of streams) {
      const wanted = plan.get(stream.key) ?? { video: null, audio: false };
      if (stream.video) applyVideo(stream.video, wanted);
      if (stream.audio) applyAudio(stream.audio, wanted);
    }
  }, [streams, focusedKey, watchedKeys, elsewhereKeys, enabled]);
}
