import { useCallback, useEffect, useRef, useState } from 'react';

export interface AutoHide {
  visible: boolean;
  /** Mouse moved / key pressed: show now and restart the timer. */
  poke(): void;
  /** While true (pointer over the controls, slider being dragged) nothing hides. */
  hold(held: boolean): void;
  hide(): void;
}

/** Visibility of overlay controls that fade out after `timeoutMs` without activity. */
export function useAutoHide(timeoutMs = 2500, enabled = true): AutoHide {
  const [visible, setVisible] = useState(false);
  const held = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const clear = useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const arm = useCallback(() => {
    clear();
    if (held.current) return;
    timer.current = window.setTimeout(() => setVisible(false), timeoutMs);
  }, [clear, timeoutMs]);

  const poke = useCallback(() => {
    if (!enabled) return;
    setVisible(true);
    arm();
  }, [arm, enabled]);

  const hold = useCallback(
    (value: boolean) => {
      held.current = value;
      if (value) {
        clear();
        setVisible(true);
      } else {
        arm();
      }
    },
    [arm, clear],
  );

  const hide = useCallback(() => {
    clear();
    setVisible(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { visible, poke, hold, hide };
}
