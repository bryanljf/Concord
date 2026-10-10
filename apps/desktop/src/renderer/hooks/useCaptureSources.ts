import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureSource } from '../../preload/api';
import { concord, toErrorMessage } from '../lib/concord';

export const CAPTURE_REFRESH_MS = 2000;

export interface UseCaptureSources {
  sources: CaptureSource[];
  /** True until the first successful fetch. */
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/** Window/screen thumbnails from main, refreshed every 2 s while `active` (SPEC 5.6). */
export function useCaptureSources(active: boolean): UseCaptureSources {
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: number | undefined;

    const load = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const list = await concord().getCaptureSources();
        if (cancelled) return;
        setSources(list);
        setError(null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(toErrorMessage(err, 'Não foi possível listar as janelas e telas.'));
        setLoading(false);
      } finally {
        inFlight.current = false;
        if (!cancelled) timer = window.setTimeout(() => void load(), CAPTURE_REFRESH_MS);
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, tick]);

  return { sources, loading, error, refresh };
}
