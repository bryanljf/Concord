import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JamRecentTrack } from '@concord/shared';
import { concord } from '../lib/concord';

const NONE: readonly JamRecentTrack[] = [];

export interface JamRecent {
  /**
   * The songs the server still has, most recently played first (`lib/jamRecent.ts` shows them).
   * Empty while inactive, until the server answers, and when it has none or could not tell: no
   * "Recentes" button then.
   */
  tracks: readonly JamRecentTrack[];
  /** Asks again (a song was just added). */
  refresh(): void;
}

/**
 * "Recentes" of the music drawer: asked each time `active` turns on (the drawer opens in a room),
 * every `refreshMs` while it stays on, and on `refresh()`; only the latest answer counts. A
 * failure is quiet and keeps the list as it was.
 */
export function useJamRecent(active: boolean, refreshMs?: number): JamRecent {
  const [tracks, setTracks] = useState<readonly JamRecentTrack[]>(NONE);
  const [request, setRequest] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    Promise.resolve()
      .then(() => concord().getJamRecent())
      .then(
        (list) => {
          if (alive) setTracks(Array.isArray(list) ? list : NONE);
        },
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [active, request]);

  useEffect(() => {
    if (!active || !refreshMs || refreshMs <= 0) return;
    const timer = window.setInterval(() => setRequest((count) => count + 1), refreshMs);
    return () => window.clearInterval(timer);
  }, [active, refreshMs]);

  const refresh = useCallback(() => setRequest((count) => count + 1), []);
  const shown = active ? tracks : NONE;
  return useMemo(() => ({ tracks: shown, refresh }), [shown, refresh]);
}
