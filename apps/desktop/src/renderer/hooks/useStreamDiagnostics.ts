import { useEffect, useState } from 'react';
import type { RemoteStream } from './useRemoteStreams';
import {
  decodePublisherSummary,
  readPublisherStats,
  statsAttributeKey,
  type PublisherStats,
} from '../lib/publisherStats';
import {
  appendPoint,
  deriveInboundPoint,
  parseInboundVideo,
  STATS_HISTORY_MS,
  STATS_SAMPLE_MS,
  type InboundPoint,
  type InboundVideoSample,
} from '../lib/rtcStats';
import { trimHistory } from '../lib/sparkline';

export interface StreamDiagnostics {
  /** `Date.now()` of the last tick; 0 before the first one. */
  now: number;
  latest: InboundVideoSample | null;
  /** Last 30 s, one point per second. */
  points: readonly InboundPoint[];
  publisher: PublisherStats;
  /** When the broadcaster's summary last changed (local clock); null without one. */
  publisherChangedAt: number | null;
}

interface KeyedDiagnostics extends StreamDiagnostics {
  key: string;
}

const MISSING: PublisherStats = { status: 'missing' };

function empty(key: string): KeyedDiagnostics {
  return { key, now: 0, latest: null, points: [], publisher: MISSING, publisherChangedAt: null };
}

/** How far back a first-seen summary's own timestamp is trusted (clocks of two PCs differ). */
const MAX_SEED_AGE_MS = 60_000;

/**
 * Receiver stats of a remote video, read every second while mounted (the stats panel is open):
 * `videoTrack.getRTCStatsReport()` into 30 s of points, plus the broadcaster's summary from the
 * participant attribute. Failures are ignored (the panel shows what it has).
 */
export function useStreamDiagnostics(stream: RemoteStream): StreamDiagnostics {
  const { key, kind, participant, videoTrack: track } = stream;
  const [state, setState] = useState<KeyedDiagnostics>(() => empty(key));

  useEffect(() => {
    let cancelled = false;
    let busy = false;
    let previous: InboundVideoSample | null = null;
    let firstRead = true;
    let lastRaw: string | undefined;
    let changedAt: number | null = null;

    const readPublisher = (at: number): PublisherStats => {
      const raw = participant.attributes[statsAttributeKey(kind)];
      if (firstRead || raw !== lastRaw) {
        if (!raw) {
          changedAt = null;
        } else {
          // A summary already there when the panel opens: trust its own time if plausible.
          const summary = firstRead ? decodePublisherSummary(raw) : null;
          changedAt = summary ? Math.min(at, Math.max(at - MAX_SEED_AGE_MS, summary.at)) : at;
        }
        firstRead = false;
        lastRaw = raw;
      }
      return readPublisherStats(participant.attributes, kind);
    };

    const commit = (
      at: number,
      publisher: PublisherStats,
      sample: InboundVideoSample | null,
      point: InboundPoint | null,
    ): void => {
      setState((current) => {
        const base = current.key === key ? current : empty(key);
        return {
          key,
          now: at,
          latest: sample ?? (track ? base.latest : null),
          points: point
            ? appendPoint(base.points, point)
            : trimHistory(base.points, at, STATS_HISTORY_MS),
          publisher,
          publisherChangedAt: changedAt,
        };
      });
    };

    const tick = (): void => {
      const at = Date.now();
      const publisher = readPublisher(at);
      if (!track) {
        commit(at, publisher, null, null);
        return;
      }
      if (busy) return;
      busy = true;
      track.getRTCStatsReport().then(
        (report) => {
          busy = false;
          if (cancelled) return;
          const sample = report ? parseInboundVideo(report) : null;
          const point = sample ? deriveInboundPoint(previous, sample, at) : null;
          if (sample) previous = sample;
          commit(at, publisher, sample, point);
        },
        () => {
          busy = false;
          // Stats are best-effort.
        },
      );
    };

    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, STATS_SAMPLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [key, kind, participant, track]);

  // Another stream's numbers never show, even for the render before the effect restarts.
  return state.key === key ? state : empty(key);
}
