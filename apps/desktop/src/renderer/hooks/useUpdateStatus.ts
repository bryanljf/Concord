import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '../../preload/api';
import { concord, toErrorMessage } from '../lib/concord';
import { DEV_BUILD_REASON } from '../lib/updates';

export interface UseUpdateStatus {
  status: UpdateStatus;
  /** Asks main to check now; errors land in `status` as `{ state: 'error' }`. */
  check(): Promise<void>;
  /** Quits and installs a `ready` update. */
  install(): Promise<void>;
}

const UNSUPPORTED: UpdateStatus = { state: 'unsupported', reason: DEV_BUILD_REASON };

/** Auto-update state from main (`electron-updater`), kept fresh through `onUpdateStatus`. */
export function useUpdateStatus(): UseUpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    let active = true;
    const unsubscribe = concord().onUpdateStatus((next) => setStatus(next));
    concord()
      .getUpdateStatus()
      .then(
        (next) => {
          if (active) setStatus(next);
        },
        () => {
          // No updater in this build (dev) or main does not expose it yet.
          if (active) setStatus(UNSUPPORTED);
        },
      );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const check = useCallback(async () => {
    setStatus({ state: 'checking' });
    try {
      setStatus(await concord().checkForUpdates());
    } catch (err) {
      setStatus({
        state: 'error',
        message: toErrorMessage(err, 'o aplicativo não respondeu.'),
      });
    }
  }, []);

  const install = useCallback(async () => {
    await concord().installUpdate();
  }, []);

  return { status, check, install };
}
