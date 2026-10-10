import { useEffect, useState } from 'react';
import { applyPresenceEvent, type PresenceSnapshot } from '@concord/shared';
import { concord, type PresenceConnectionStatus, type PresenceState } from '../lib/concord';

const EMPTY_SNAPSHOT: PresenceSnapshot = { rooms: {} };
const INITIAL_STATUS: PresenceConnectionStatus = { state: 'idle', reason: 'no_session' };

/** Live presence (who is in which room) and the state of main's SSE connection. */
export function usePresence(): PresenceState {
  const [snapshot, setSnapshot] = useState<PresenceSnapshot>(EMPTY_SNAPSHOT);
  const [status, setStatus] = useState<PresenceConnectionStatus>(INITIAL_STATUS);

  useEffect(() => {
    const api = concord();
    let active = true;
    // Subscribe before fetching so nothing emitted in between is lost.
    const unsubscribeEvents = api.onPresenceEvent((event) => {
      setSnapshot((prev) => applyPresenceEvent(prev, event));
    });
    const unsubscribeStatus = api.onPresenceStatus((next) => setStatus(next));
    api.getPresence().then(
      (state) => {
        if (!active) return;
        setSnapshot(state.snapshot);
        setStatus(state.status);
      },
      () => {
        // Status events will report the failure; keep the empty snapshot.
      },
    );
    return () => {
      active = false;
      unsubscribeEvents();
      unsubscribeStatus();
    };
  }, []);

  return { snapshot, status };
}
