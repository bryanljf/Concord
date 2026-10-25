/**
 * Every room's jam as last received on the presence SSE (`?jam=1`). Until the server sends a
 * `jam_snapshot` (and forever with a server from before the Jam, which ignores the query) the
 * jam is unavailable, so the renderer hides it.
 */
import { applyJamEvent, type JamEvent, type JamSnapshot } from '@concord/shared';

export const UNAVAILABLE_JAM: JamSnapshot = { available: false, rooms: {}, serverTime: 0 };

export type JamEventListener = (event: JamEvent) => void;

export interface JamStore {
  get(): JamSnapshot;
  /**
   * `get()` with `serverTime` moved forward by the time since it arrived, so a renderer that
   * asks long after the last event still derives the right clock offset from it.
   */
  snapshotNow(): JamSnapshot;
  /** Applies a validated event and re-emits it. */
  apply(event: JamEvent): void;
  /** Back to unavailable (no connection), emitting that as a snapshot when anything changes. */
  reset(): void;
  onEvent(listener: JamEventListener): () => void;
}

export function createJamStore(now: () => number = Date.now): JamStore {
  let snapshot = UNAVAILABLE_JAM;
  /** Local clock when `snapshot.serverTime` was received. */
  let receivedAt = 0;
  const listeners = new Set<JamEventListener>();

  function emit(event: JamEvent): void {
    for (const listener of listeners) listener(event);
  }

  return {
    get: () => snapshot,
    snapshotNow() {
      if (snapshot.serverTime === 0) return snapshot;
      const elapsed = Math.max(0, now() - receivedAt);
      return elapsed === 0 ? snapshot : { ...snapshot, serverTime: snapshot.serverTime + elapsed };
    },
    apply(event) {
      snapshot = applyJamEvent(snapshot, event);
      receivedAt = now();
      emit(event);
    },
    reset() {
      if (snapshot === UNAVAILABLE_JAM) return;
      snapshot = UNAVAILABLE_JAM;
      emit({ type: 'jam_snapshot', data: UNAVAILABLE_JAM });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
