import { useCallback, useEffect, useRef, useState } from 'react';

export interface AutoHide {
  visible: boolean;
  /** Mouse moved / key pressed: show now and restart the timer. */
  poke(): void;
  /** While true (a slider being dragged) nothing hides. */
  hold(held: boolean): void;
  hide(): void;
}

/**
 * Visibility of overlay controls that fade out after `timeoutMs` without activity. When the timer
 * runs out, `keep()` says whether the pointer still rests on the controls (checked live with
 * `:hover`, so a lost mouseleave can never leave them stuck on screen); if so it waits again.
 */
export function useAutoHide(timeoutMs = 2500, enabled = true, keep?: () => boolean): AutoHide {
  const [visible, setVisible] = useState(false);
  const held = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const keepRef = useRef(keep);
  useEffect(() => {
    keepRef.current = keep;
  }, [keep]);

  const clear = useCallback(() => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const arm = useCallback(() => {
    clear();
    if (held.current) return;
    const expire = (): void => {
      timer.current = undefined;
      if (keepRef.current?.()) {
        timer.current = window.setTimeout(expire, timeoutMs);
        return;
      }
      setVisible(false);
    };
    timer.current = window.setTimeout(expire, timeoutMs);
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
    held.current = false;
    setVisible(false);
  }, [clear]);

  useEffect(() => clear, [clear]);

  return { visible, poke, hold, hide };
}
