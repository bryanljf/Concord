import { useCallback, useEffect } from 'react';
import { concord } from '../lib/concord';
import { useToast } from './useToast';

export interface UseStreamToggle {
  /** Start/stop streaming — until Phase 3 this only explains that streaming is not here yet. */
  requestToggle(): void;
}

/** Handles "Transmitir…" requests from the tray/global shortcut and from the UI button. */
export function useStreamToggle(): UseStreamToggle {
  const toast = useToast();

  const requestToggle = useCallback(() => {
    toast.show('Transmissão chega na próxima fase.');
  }, [toast]);

  useEffect(() => concord().onStreamToggleRequested(requestToggle), [requestToggle]);

  return { requestToggle };
}
