import { useCallback, useEffect, useState } from 'react';
import { concord } from '../lib/concord';

export interface UseFullscreen {
  /** Mirrors the BrowserWindow state pushed by main. */
  fullscreen: boolean;
  /** Rejects with a pt-BR-safe error when main cannot change the window. */
  setFullscreen(enabled: boolean): Promise<void>;
  toggle(): Promise<void>;
}

export function useFullscreen(): UseFullscreen {
  const [fullscreen, setState] = useState(false);

  useEffect(() => concord().onFullscreenChanged((enabled) => setState(enabled)), []);

  const setFullscreen = useCallback(async (enabled: boolean) => {
    await concord().setFullscreen(enabled);
  }, []);

  const toggle = useCallback(() => setFullscreen(!fullscreen), [fullscreen, setFullscreen]);

  return { fullscreen, setFullscreen, toggle };
}
