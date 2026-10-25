import { useEffect, useMemo, useState } from 'react';
import { createRevealTimer, TOUCH_REVEAL_MS } from '../lib/touch';

export interface TouchReveal {
  revealed: boolean;
  /**
   * A tap on the thing that reveals: hidden, it reveals and returns true (the tap is spent);
   * shown, it keeps the controls a while longer and returns false (the tap acts).
   */
  tap(): boolean;
  /** Shows (or keeps showing) for the duration again, e.g. while a revealed slider is used. */
  show(): void;
  hide(): void;
}

/**
 * Controls that only hover shows (a tile's ×, its volume, a viewer list's names) on a touch
 * screen: the first tap shows them for `durationMs`, the next one acts. The caller adds a class
 * while `revealed` (the stylesheets mirror their `:hover` rules on it) and asks `tap()` before
 * acting on a click.
 */
export function useTouchReveal(durationMs = TOUCH_REVEAL_MS): TouchReveal {
  const [revealed, setRevealed] = useState(false);
  const timer = useMemo(() => createRevealTimer(setRevealed, durationMs), [durationMs]);
  // Unmounting stops the clock (nothing to show any more).
  useEffect(() => () => timer.hide(), [timer]);
  return { revealed, tap: timer.tap, show: timer.show, hide: timer.hide };
}
