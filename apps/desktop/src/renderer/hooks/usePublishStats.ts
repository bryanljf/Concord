import { useEffect, useMemo, useRef } from 'react';
import { ConnectionState, type LocalVideoTrack, type Room } from 'livekit-client';
import {
  buildPublisherSummary,
  encodePublisherSummary,
  PUBLISH_INTERVAL_MS,
  statsAttributeKey,
  type PublisherSummary,
} from '../lib/publisherStats';
import {
  appendPoint,
  deriveOutboundPoint,
  parseOutboundVideo,
  STATS_SAMPLE_MS,
  summarizeOutbound,
  type OutboundPoint,
  type OutboundVideoSample,
} from '../lib/rtcStats';
import type { StreamKind } from '../lib/streamKey';

/** What the stats panel reads from one of your videos. */
export interface LocalStatsSnapshot {
  /** `Date.now()` of the last sample; 0 before the first. */
  updatedAt: number;
  /** Frame rate the last summary was built with; 0 before the first sample. */
  targetFps: number;
  /** Raw last reading of the sender (for "Copiar diagnóstico"). */
  sample: OutboundVideoSample | null;
  latest: OutboundPoint | null;
  /** Last 30 s, one point per second. */
  points: readonly OutboundPoint[];
  /** What was last written to the participant attribute. */
  published: PublisherSummary | null;
}

/**
 * Sender-side samples of one local video. Opaque outside the statistics modules: a small store
 * that the stats panel subscribes to, so the owner (Workspace) does not re-render every second.
 */
export interface LocalStatsHistory {
  readonly source: StreamKind;
  getSnapshot(): LocalStatsSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface LocalStatsSources {
  /** Your published screen share (`getTrackPublication(ScreenShare).videoTrack`), if live. */
  screen: LocalVideoTrack | null;
  /** Frame rate of the screen preset (30 or 60). */
  screenTargetFps: number;
  /** Your published webcam, if on. */
  camera: LocalVideoTrack | null;
}

export interface LocalStats {
  screen: LocalStatsHistory | null;
  camera: LocalStatsHistory | null;
}

/** The webcam is captured and encoded at 30 fps (see `useCamera`). */
const CAMERA_TARGET_FPS = 30;

class LocalStatsStore implements LocalStatsHistory {
  private snapshot: LocalStatsSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(readonly source: StreamKind) {
    this.snapshot = {
      updatedAt: 0,
      targetFps: 0,
      sample: null,
      latest: null,
      points: [],
      published: null,
    };
  }

  // Arrow properties: stable references for `useSyncExternalStore`.
  getSnapshot = (): LocalStatsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  update(patch: Partial<LocalStatsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function isConnected(room: Room): boolean {
  return room.state === ConnectionState.Connected;
}

/** One local video: sample every second, publish the summary every 5 s while connected. */
function useSourceStats(
  room: Room,
  connected: boolean,
  kind: StreamKind,
  track: LocalVideoTrack | null,
  targetFps: number,
): LocalStatsHistory | null {
  // A new store per track: a restarted share starts with an empty history.
  const store = useMemo(() => (track ? new LocalStatsStore(kind) : null), [kind, track]);
  const connectedRef = useRef(connected);
  const targetRef = useRef(targetFps);
  useEffect(() => {
    connectedRef.current = connected;
    targetRef.current = targetFps;
  }, [connected, targetFps]);

  useEffect(() => {
    if (!store || !track) return;
    const key = statsAttributeKey(kind);
    let cancelled = false;
    let busy = false;
    let previous: OutboundVideoSample | null = null;
    let lastPublishAt = 0;
    let publishing = false;
    let written = false;

    const publish = (at: number): void => {
      if (publishing || !connectedRef.current || !isConnected(room)) return;
      const { points, latest } = store.getSnapshot();
      const recent = summarizeOutbound(points, at - PUBLISH_INTERVAL_MS);
      if (!recent || !latest) return;
      const summary = buildPublisherSummary({
        at,
        targetFps: targetRef.current,
        window: recent,
        latest,
      });
      lastPublishAt = at;
      publishing = true;
      written = true;
      store.update({ published: summary });
      room.localParticipant
        .setAttributes({ [key]: encodePublisherSummary(summary) })
        .catch(() => {
          // Best-effort: the next summary goes out in 5 s.
        })
        .finally(() => {
          publishing = false;
        });
    };

    const tick = (): void => {
      if (busy) return;
      busy = true;
      const at = Date.now();
      track.getRTCStatsReport().then(
        (report) => {
          busy = false;
          if (cancelled || !report) return;
          const sample = parseOutboundVideo(report);
          if (!sample) return;
          const point = deriveOutboundPoint(previous, sample, at);
          previous = sample;
          const current = store.getSnapshot();
          store.update({
            updatedAt: at,
            targetFps: targetRef.current,
            sample,
            ...(point ? { latest: point, points: appendPoint(current.points, point) } : {}),
          });
          // The first summary as soon as there is a point, then every 5 s.
          if (point && at - lastPublishAt >= PUBLISH_INTERVAL_MS) publish(at);
        },
        () => {
          busy = false;
          // Stats are best-effort.
        },
      );
    };

    const timer = window.setInterval(tick, STATS_SAMPLE_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      // The video stopped (or the app is leaving): viewers must not keep stale numbers.
      if (written && connectedRef.current && isConnected(room)) {
        room.localParticipant.setAttributes({ [key]: '' }).catch(() => undefined);
      }
    };
  }, [room, kind, store, track]);

  return store;
}

/**
 * Samples the sender stats of your screen share and webcam every second while they are live,
 * publishes a short summary as the `concord.stats.screen` / `concord.stats.camera` participant
 * attributes every 5 s (cleared when they stop) and returns the last 30 s for the stats panel.
 * The returned histories only change identity when a video starts or stops.
 */
export function usePublishStats(
  room: Room,
  connected: boolean,
  sources: LocalStatsSources,
): LocalStats {
  const screen = useSourceStats(room, connected, 'screen', sources.screen, sources.screenTargetFps);
  const camera = useSourceStats(room, connected, 'camera', sources.camera, CAMERA_TARGET_FPS);
  return useMemo(() => ({ screen, camera }), [screen, camera]);
}
