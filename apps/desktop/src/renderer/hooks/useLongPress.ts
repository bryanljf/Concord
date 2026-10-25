import { useEffect, useMemo, useRef, type MouseEvent, type PointerEvent } from 'react';
import type { Point } from '../lib/contextMenu';
import { createLongPress, type LongPress } from '../lib/touch';

/** Handlers to spread on the element (next to its own `onContextMenu` and `onClick`). */
export interface LongPressHandlers {
  onPointerDown(event: PointerEvent<HTMLElement>): void;
  onPointerMove(event: PointerEvent<HTMLElement>): void;
  onPointerUp(event: PointerEvent<HTMLElement>): void;
  onPointerCancel(event: PointerEvent<HTMLElement>): void;
  onContextMenuCapture(event: MouseEvent<HTMLElement>): void;
  onClickCapture(event: MouseEvent<HTMLElement>): void;
}

/**
 * A finger held on the element for `LONG_PRESS_MS` (without moving or scrolling) calls
 * `onLongPress` with the touch point and the element, the way a right click would. Only touch
 * pointers count. The browser's own long-press `contextmenu` (Android) is taken as the same
 * press, so the menu opens once, at the finger; the click that may follow the lift is swallowed,
 * so the tile's tap action never runs after its menu opened. iOS fires no `contextmenu` for
 * touch: there the timer alone does it.
 */
export function useLongPress(
  onLongPress: (element: HTMLElement, point: Point) => void,
  enabled = true,
): LongPressHandlers {
  const latest = useRef(onLongPress);
  useEffect(() => {
    latest.current = onLongPress;
  }, [onLongPress]);

  const press = useRef<LongPress | null>(null);
  const element = useRef<HTMLElement | null>(null);
  const pointerId = useRef<number | null>(null);
  const swallowClick = useRef(false);

  return useMemo<LongPressHandlers>(() => {
    const pressOf = (): LongPress => {
      press.current ??= createLongPress((point) => {
        const target = element.current;
        if (!target) return;
        swallowClick.current = true;
        latest.current(target, point);
      });
      return press.current;
    };
    const point = (event: PointerEvent<HTMLElement>): Point => ({
      x: event.clientX,
      y: event.clientY,
    });
    const ownsPointer = (event: PointerEvent<HTMLElement>): boolean =>
      pointerId.current === event.pointerId;

    return {
      onPointerDown(event) {
        swallowClick.current = false;
        if (!enabled || event.pointerType !== 'touch' || !event.isPrimary) {
          // A mouse or a pen: the right click is theirs, nothing of the last press lingers.
          press.current?.reset();
          pointerId.current = null;
          return;
        }
        element.current = event.currentTarget;
        pointerId.current = event.pointerId;
        pressOf().down(point(event));
      },
      onPointerMove(event) {
        if (ownsPointer(event)) press.current?.move(point(event));
      },
      onPointerUp(event) {
        if (!ownsPointer(event)) return;
        press.current?.up();
        pointerId.current = null;
      },
      onPointerCancel(event) {
        // The browser took the finger (a scroll, a system gesture): no press.
        if (!ownsPointer(event)) return;
        press.current?.up();
        pointerId.current = null;
      },
      onContextMenuCapture(event) {
        // Our own `contextmenu` (dispatched for the press) goes through to the element's handler.
        if (!event.nativeEvent.isTrusted) return;
        const current = press.current;
        // Nothing of ours going on: a right click or the keyboard, also through.
        if (!current || (!current.pending && !current.fired)) return;
        event.preventDefault();
        event.stopPropagation();
        // The browser's long press came before our timer: fire now, once this event is over.
        if (current.pending) queueMicrotask(() => current.fireNow());
      },
      onClickCapture(event) {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        event.preventDefault();
        event.stopPropagation();
      },
    };
  }, [enabled]);
}
