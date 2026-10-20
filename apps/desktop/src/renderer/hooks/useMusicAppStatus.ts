import { useEffect, useState } from 'react';
import type { MusicAppId, MusicAppStatus } from '../../preload/api';
import { concord } from '../lib/concord';

/**
 * Whether a music app runs and what it plays (main reads the Windows media controls): main's
 * current answer, then every change it pushes. Null while disabled or until main answers; a
 * failed request reads as "not running". Bump `refreshKey` to ask main again ("Tentar de novo").
 */
export function useMusicAppStatus(
  app: MusicAppId,
  enabled: boolean,
  refreshKey = 0,
): MusicAppStatus | null {
  const [status, setStatus] = useState<MusicAppStatus | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // A pushed status is newer than the answer to a request sent before it.
    let pushed = false;
    const api = concord();
    const unsubscribe = api.onMusicAppStatus((next) => {
      if (!active || next.app !== app) return;
      pushed = true;
      setStatus(next);
    });
    api.getMusicAppStatus(app).then(
      (current) => {
        if (active && !pushed) setStatus(current);
      },
      () => {
        if (active && !pushed) setStatus({ app, running: false, nowPlaying: null });
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [app, enabled, refreshKey]);

  // A status of another app (or from before disabling) never leaks out.
  return enabled && status?.app === app ? status : null;
}
