import { useCallback, useEffect, useRef, useState } from 'react';
import { toVideoInputs, type VideoInput } from '../lib/cameraEncoding';

export type { VideoInput };

export interface UseVideoInputs {
  /** Connected webcams, in the system's order. */
  devices: VideoInput[];
  /**
   * Lists the devices again. Call it after a camera was opened: names only show up once the app
   * was allowed to use a camera, and that does not fire `devicechange`.
   */
  refresh(): void;
}

/** The webcams (`videoinput` devices), kept up to date on `devicechange` (plug/unplug). */
export function useVideoInputs(): UseVideoInputs {
  const [devices, setDevices] = useState<VideoInput[]>([]);
  // Only the latest enumeration is applied (they can overlap on fast plug/unplug).
  const sequence = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    const seq = ++sequence.current;
    navigator.mediaDevices.enumerateDevices().then(
      (list) => {
        if (mounted.current && seq === sequence.current) setDevices(toVideoInputs(list));
      },
      () => {
        // Keep the previous list; the system default is always offered.
      },
    );
  }, []);

  useEffect(() => {
    mounted.current = true;
    const media = navigator.mediaDevices;
    media.addEventListener('devicechange', refresh);
    refresh();
    return () => {
      mounted.current = false;
      media.removeEventListener('devicechange', refresh);
    };
  }, [refresh]);

  return { devices, refresh };
}
