import { useEffect, useRef } from 'react';
import type { RoomId } from '@concord/shared';
import { playViewerJoined, playViewerLeft } from '../lib/transmissionSounds';
import { diffViewers, type ViewersByLive } from '../lib/viewers';

export interface ViewerSoundsOptions {
  viewers: ViewersByLive;
  currentRoom: RoomId | null;
  /** Only while connected: (re)connecting rebuilds the room and would replay everyone. */
  connected: boolean;
  /**
   * Your own live while you broadcast, plus the watched lives that are still live: a live that
   * ends makes its viewers stop watching, and that must not ring as people leaving.
   */
  involvedLiveIds: readonly string[];
  selfId: string;
  /** `Settings.viewerSounds`. */
  enabled: boolean;
}

/**
 * Plays a short chime when someone starts or stops watching a live you are part of (yours, or
 * one you watch), like Discord's Go Live. The first snapshot after entering a room or reconnecting is the baseline: people who
 * were already watching never ring.
 */
export function useViewerSounds({
  viewers,
  currentRoom,
  connected,
  involvedLiveIds,
  selfId,
  enabled,
}: ViewerSoundsOptions): void {
  const baseline = useRef<{ room: RoomId; viewers: ViewersByLive } | null>(null);
  // Only a new viewer snapshot can ring; these are read as they are at that moment.
  const latest = useRef({ involvedLiveIds, selfId, enabled });
  useEffect(() => {
    latest.current = { involvedLiveIds, selfId, enabled };
  }, [involvedLiveIds, selfId, enabled]);

  useEffect(() => {
    if (!connected || currentRoom === null) {
      baseline.current = null;
      return;
    }
    const prev = baseline.current;
    baseline.current = { room: currentRoom, viewers };
    const { involvedLiveIds: involved, selfId: self, enabled: on } = latest.current;
    if (!on || !prev || prev.room !== currentRoom) return;
    const { joined, left } = diffViewers(prev.viewers, viewers, involved, self);
    if (joined.length > 0) playViewerJoined();
    else if (left.length > 0) playViewerLeft();
  }, [viewers, connected, currentRoom]);
}
