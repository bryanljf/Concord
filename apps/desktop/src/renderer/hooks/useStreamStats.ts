import { useEffect, useState } from 'react';
import type { RemoteVideoTrack } from 'livekit-client';
import { deriveStats, type StatsSample, type StreamStats } from '../lib/streamStats';

const SAMPLE_MS = 1000;

interface Sampled {
  track: RemoteVideoTrack;
  stats: StreamStats;
}

/**
 * Bitrate / fps / resolution of a subscribed video track, sampled every second from the
 * receiver's `inbound-rtp` stats (`RemoteVideoTrack.getReceiverStats()`) while `active`.
 */
export function useStreamStats(
  track: RemoteVideoTrack | null,
  active: boolean,
): StreamStats | null {
  const [sampled, setSampled] = useState<Sampled | null>(null);

  useEffect(() => {
    if (!track || !active) return;
    let cancelled = false;
    let previous: StatsSample | null = null;
    const timer = window.setInterval(() => {
      track.getReceiverStats().then(
        (received) => {
          if (cancelled || !received) return;
          const sample: StatsSample = {
            timestamp: received.timestamp ?? performance.now(),
            bytesReceived: received.bytesReceived ?? 0,
            framesDecoded: received.framesDecoded ?? 0,
            frameWidth: received.frameWidth,
            frameHeight: received.frameHeight,
            codec: received.mimeType,
          };
          const stats = deriveStats(previous, sample);
          previous = sample;
          if (stats) setSampled({ track, stats });
        },
        () => {
          // Stats are best-effort.
        },
      );
    }, SAMPLE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [track, active]);

  // Stale numbers from another track (or from before the controls were hidden) never show.
  return active && track && sampled?.track === track ? sampled.stats : null;
}
