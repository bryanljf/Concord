import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { isContextMenuKey, type Point } from '../lib/contextMenu';

export interface OpenContextMenu<T> {
  /** What the menu is about (e.g. which live). */
  target: T;
  /** Viewport coordinates the menu opens at (clamped to the viewport by <ContextMenu>). */
  point: Point;
}

export interface UseContextMenu<T> {
  menu: OpenContextMenu<T> | null;
  /** `onContextMenu` handler: opens at the pointer (or at the element for a keyboard request). */
  onContextMenu(event: ReactMouseEvent<HTMLElement>, target: T): void;
  /** `onKeyDown` handler: ContextMenu key / Shift+F10 open the menu at the element. */
  onKeyDown(event: ReactKeyboardEvent<HTMLElement>, target: T): void;
  /** Closes the menu and gives the focus back to the element it was opened from. */
  close(): void;
}

/** A keyboard request that also fires `contextmenu` right after is the same request. */
const KEYBOARD_ECHO_MS = 400;

function anchorPoint(element: HTMLElement): Point {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + 12, y: rect.top + 12 };
}

/**
 * State for a custom (non-native) context menu shared by several elements: which element opened
 * it, where, and focus return on close. Render `<ContextMenu>` when `menu` is set.
 *
 * @param fallbackFocus where the focus goes on close when the element that opened the menu is
 *   no longer in the document.
 */
export function useContextMenu<T>(fallbackFocus?: () => HTMLElement | null): UseContextMenu<T> {
  const [menu, setMenu] = useState<OpenContextMenu<T> | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const keyboardAt = useRef(0);

  const open = useCallback((element: HTMLElement, target: T, point: Point) => {
    anchor.current = element;
    setMenu({ target, point });
  }, []);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, target: T) => {
      event.preventDefault();
      event.stopPropagation();
      // The ContextMenu key may also fire `contextmenu` after our keydown handler opened it.
      if (performance.now() - keyboardAt.current < KEYBOARD_ECHO_MS) return;
      const element = event.currentTarget;
      // Right button = pointer; anything else (keyboard-generated event) opens at the element.
      const point =
        event.button === 2 ? { x: event.clientX, y: event.clientY } : anchorPoint(element);
      open(element, target, point);
    },
    [open],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, target: T) => {
      if (!isContextMenuKey(event)) return;
      event.preventDefault();
      event.stopPropagation();
      keyboardAt.current = performance.now();
      const element = event.currentTarget;
      open(element, target, anchorPoint(element));
    },
    [open],
  );

  const fallback = useRef(fallbackFocus);
  useEffect(() => {
    fallback.current = fallbackFocus;
  }, [fallbackFocus]);

  const close = useCallback(() => {
    setMenu(null);
    const element = anchor.current;
    anchor.current = null;
    // After React applied the chosen action: the element may be gone ("Parar de assistir" or
    // "Colocar em destaque" removed the mini tile), and an outside click may have focused
    // something else on purpose, which keeps the focus.
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const destination = element?.isConnected ? element : (fallback.current?.() ?? null);
      destination?.focus({ preventScroll: true });
    });
  }, []);

  return { menu, onContextMenu, onKeyDown, close };
}
