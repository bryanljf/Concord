import { useEffect, useState } from 'react';
import type { ServerInfoResponse } from '@concord/shared';
import { concord } from '../lib/concord';
import { trimPingHistory, type PingSample } from '../lib/ping';

/** One ping per second: 30 points in the tooltip chart. */
const PING_INTERVAL_MS = 1000;

export interface ServerPing {
  /** Last round trip in milliseconds; null until measured. */
  ms: number | null;
  /** The last ping got no answer. */
  lost: boolean;
  /** Instance name and region; null until known (or on an older server). */
  info: ServerInfoResponse | null;
  /** The last 30 s of pings, oldest first (unanswered ones with `ms: null`). */
  history: readonly PingSample[];
}

const IDLE: ServerPing = { ms: null, lost: false, info: null, history: [] };

/**
 * Pings the server every second while `active` (you are in a room). The very first ping also
 * opens the connection (TCP/TLS), so it is thrown away and repeated at once.
 */
export function useServerPing(active: boolean): ServerPing {
  const [state, setState] = useState<ServerPing>(IDLE);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;

    concord()
      .getServerInfo()
      .then(
        (info) => {
          if (!cancelled) setState((prev) => ({ ...prev, info }));
        },
        () => undefined,
      );

    const record = (ms: number | null): void => {
      const now = Date.now();
      setState((prev) => ({
        ...prev,
        ms: ms ?? prev.ms,
        lost: ms === null,
        history: trimPingHistory([...prev.history, { at: now, ms }], now),
      }));
    };

    const measure = async (warmUp: boolean): Promise<void> => {
      try {
        const ms = await concord().pingServer();
        if (cancelled) return;
        if (warmUp) {
          void measure(false);
          return;
        }
        record(ms);
      } catch {
        if (cancelled) return;
        record(null);
      }
      timer = window.setTimeout(() => void measure(false), PING_INTERVAL_MS);
    };
    void measure(true);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      // The next room starts with a clean chart.
      setState(IDLE);
    };
  }, [active]);

  return active ? state : IDLE;
}
