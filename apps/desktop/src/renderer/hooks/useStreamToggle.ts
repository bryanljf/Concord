import { useEffect, useRef } from 'react';
import { concord } from '../lib/concord';

interface UseStreamToggleOptions {
  /** A broadcast is live or starting, so the request means "stop". */
  streaming: boolean;
  onStart(): void;
  onStop(): void;
}

/**
 * Tray item "Transmitir…" / "Parar transmissão" and the global shortcut both arrive as one
 * toggle request from main: start opens the source picker, stop ends the broadcast.
 */
export function useStreamToggle({ streaming, onStart, onStop }: UseStreamToggleOptions): void {
  const latest = useRef({ streaming, onStart, onStop });
  useEffect(() => {
    latest.current = { streaming, onStart, onStop };
  }, [streaming, onStart, onStop]);

  useEffect(
    () =>
      concord().onStreamToggleRequested(() => {
        const { streaming: active, onStart: start, onStop: stop } = latest.current;
        if (active) stop();
        else start();
      }),
    [],
  );
}
