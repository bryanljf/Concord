import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '../../preload/api';
import { capabilities } from '../lib/capabilities';
import { concord, toErrorMessage } from '../lib/concord';
import { DEV_BUILD_REASON, WEB_UPDATE_STATUS } from '../lib/updates';

export interface UseUpdateStatus {
  status: UpdateStatus;
  /** Asks main to check now; errors land in `status` as `{ state: 'error' }`. */
  check(): Promise<void>;
  /** Quits and installs a `ready` update. */
  install(): Promise<void>;
}

const UNSUPPORTED: UpdateStatus = { state: 'unsupported', reason: DEV_BUILD_REASON };

/**
 * Auto-update state from main (`electron-updater`), kept fresh through `onUpdateStatus`. A client
 * without an updater (`capabilities.updates`, the web) stays `unsupported` without asking the
 * bridge, so the banner and the sidebar's arrow never show there.
 */
export function useUpdateStatus(): UseUpdateStatus {
  const supported = capabilities().updates;
  const [status, setStatus] = useState<UpdateStatus>(
    supported ? { state: 'idle' } : WEB_UPDATE_STATUS,
  );

  useEffect(() => {
    if (!supported) return;
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
  }, [supported]);

  const check = useCallback(async () => {
    if (!supported) return;
    setStatus({ state: 'checking' });
    try {
      setStatus(await concord().checkForUpdates());
    } catch (err) {
      setStatus({
        state: 'error',
        message: toErrorMessage(err, 'o aplicativo não respondeu.'),
      });
    }
  }, [supported]);

  const install = useCallback(async () => {
    if (!supported) return;
    await concord().installUpdate();
  }, [supported]);

  return { status, check, install };
}
