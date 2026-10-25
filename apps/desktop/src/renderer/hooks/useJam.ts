import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyJamEvent,
  type JamEvent,
  type JamItem,
  type JamSnapshot,
  type JamState,
  type RoomId,
} from '@concord/shared';
import type { JamUploadStatus } from '../../preload/api';
import { concord } from '../lib/concord';
import {
  addJamClockSample,
  jamAddedStatus,
  jamClockOffset,
  withAddedStatuses,
  type JamClockSample,
} from '../lib/jam';

export interface JamData {
  /** The server has a jam bot; false (also while loading): no Jam anywhere in the UI. */
  available: boolean;
  /** Only rooms with something playing or queued. */
  rooms: Readonly<Record<string, JamState>>;
  /** Server clock minus this PC's (ms): progress bars use `Date.now() + clockOffsetMs`. */
  clockOffsetMs: number;
}

const EMPTY_SNAPSHOT: JamSnapshot = { available: false, rooms: {}, serverTime: 0 };

interface JamHookState {
  snapshot: JamSnapshot;
  samples: readonly JamClockSample[];
}

function serverTimeOf(event: JamEvent): number {
  return event.type === 'jam_snapshot' ? event.data.serverTime : event.serverTime;
}

/**
 * Every room's Jam, as main receives it next to presence: `getJam()` once, then `onJamEvent`.
 * Events that arrive before the first answer are replayed on top of it (each one replaces a whole
 * room, so a repeat is harmless). Each message also reads the server clock for the progress bars.
 */
export function useJam(): JamData {
  const [state, setState] = useState<JamHookState>({ snapshot: EMPTY_SNAPSHOT, samples: [] });

  useEffect(() => {
    const api = concord();
    let active = true;
    let loaded = false;
    const early: JamEvent[] = [];
    // Subscribe before fetching so nothing emitted in between is lost.
    const unsubscribe = api.onJamEvent((event) => {
      const receivedAt = Date.now();
      if (!loaded) early.push(event);
      setState((prev) => ({
        snapshot: applyJamEvent(prev.snapshot, event),
        samples: addJamClockSample(prev.samples, serverTimeOf(event), receivedAt),
      }));
    });
    api.getJam().then(
      (snapshot) => {
        if (!active) return;
        const receivedAt = Date.now();
        loaded = true;
        const replayed = early.splice(0).reduce(applyJamEvent, snapshot);
        setState((prev) => ({
          snapshot: replayed,
          samples: addJamClockSample(prev.samples, snapshot.serverTime, receivedAt),
        }));
      },
      () => {
        // Events will bring the state (or the Jam stays hidden).
        loaded = true;
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const { snapshot, samples } = state;
  return {
    available: snapshot.available,
    rooms: snapshot.available ? snapshot.rooms : EMPTY_SNAPSHOT.rooms,
    clockOffsetMs: jamClockOffset(samples),
  };
}

const NO_UPLOADS: ReadonlyMap<string, JamUploadStatus> = new Map();

export interface JamUploads {
  /** By item id: where each of your songs is (`lib/jam.ts` `jamItemStatusLabel` reads it). */
  uploads: ReadonlyMap<string, JamUploadStatus>;
  /**
   * `addToJam` resolved with `item`: one the server already had (`ready`) never shows
   * "Baixando…", whatever arrives later.
   */
  noteAdded(room: RoomId, item: JamItem): void;
}

/**
 * This app's part in the songs it added (downloading from YouTube, sending to the server), by
 * item id. A song that could not be sent calls `onError` (main already took it off the queue);
 * failures from before this window opened are not reported again.
 */
export function useJamUploads(onError: (status: JamUploadStatus) => void): JamUploads {
  const [uploads, setUploads] = useState<ReadonlyMap<string, JamUploadStatus>>(NO_UPLOADS);
  const [added, setAdded] = useState<ReadonlyMap<string, JamUploadStatus>>(NO_UPLOADS);
  const latestOnError = useRef(onError);
  useEffect(() => {
    latestOnError.current = onError;
  }, [onError]);

  useEffect(() => {
    const api = concord();
    let active = true;
    let changed = false;
    const unsubscribe = api.onJamUploadStatus((status) => {
      changed = true;
      setUploads((prev) => {
        const next = new Map(prev);
        next.set(status.itemId, status);
        return next;
      });
      if (status.state === 'error') latestOnError.current(status);
    });
    api.getJamUploads().then(
      (initial) => {
        if (!active || initial.length === 0) return;
        setUploads((prev) => {
          // A status pushed meanwhile is newer than this list.
          const next = new Map(initial.map((status) => [status.itemId, status]));
          if (changed) for (const [id, status] of prev) next.set(id, status);
          return next;
        });
      },
      () => undefined,
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const noteAdded = useCallback((room: RoomId, item: JamItem) => {
    const status = jamAddedStatus(room, item);
    if (!status) return;
    setAdded((prev) => {
      const next = new Map(prev);
      next.set(status.itemId, status);
      return next;
    });
  }, []);

  const merged = useMemo(() => withAddedStatuses(uploads, added), [uploads, added]);
  return useMemo(() => ({ uploads: merged, noteAdded }), [merged, noteAdded]);
}
