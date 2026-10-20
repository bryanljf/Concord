import { screen, type BrowserWindow, type Point, type Rectangle } from 'electron';
import { log } from './log';

const logger = log('window-drag');

/** Cursor polling period while dragging (~60 Hz). */
export const DRAG_POLL_MS = 16;
/** A drag that never receives `end` (lost pointerup) stops by itself after this long. */
export const DRAG_SAFETY_TIMEOUT_MS = 60_000;
/** In `reachable` mode, how much of the window must stay inside the work area. */
export const DRAG_MIN_VISIBLE = 64;

/**
 * `inside`: the whole window stays in the work area (picture-in-picture).
 * `reachable`: it may go partly off-screen, but its top edge (where the renderer's drag strip
 * lives) stays on screen and at least `DRAG_MIN_VISIBLE` px remain visible (pop-out).
 */
export type DragClamp = 'inside' | 'reachable';

export interface Size {
  width: number;
  height: number;
}

function clamp(value: number, min: number, max: number): number {
  // When the window is larger than the room it has, `min` wins (top/left stays reachable).
  return Math.max(min, Math.min(value, max));
}

/**
 * Where the window goes for a cursor position: the grab offset is kept, then the position is
 * clamped to `area` (the work area of the display under the cursor). Pure.
 */
export function dragBounds(
  cursor: Point,
  offset: Point,
  size: Size,
  area: Rectangle,
  mode: DragClamp,
): Rectangle {
  const x = cursor.x - offset.x;
  const y = cursor.y - offset.y;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  if (mode === 'inside') {
    return {
      x: Math.round(clamp(x, area.x, right - size.width)),
      y: Math.round(clamp(y, area.y, bottom - size.height)),
      width: size.width,
      height: size.height,
    };
  }
  const visibleX = Math.min(DRAG_MIN_VISIBLE, size.width);
  const visibleY = Math.min(DRAG_MIN_VISIBLE, size.height);
  return {
    x: Math.round(clamp(x, area.x - size.width + visibleX, right - visibleX)),
    y: Math.round(clamp(y, area.y, bottom - visibleY)),
    width: size.width,
    height: size.height,
  };
}

export interface DragOptions {
  mode: DragClamp;
  /** Runs after `end()` and after the safety timeout (not after `cancel()` or a closed window). */
  onEnd?(bounds: Rectangle): void;
}

export interface WindowDrag {
  /** Starts following the cursor with `win`; any other drag in progress is cancelled. */
  start(win: BrowserWindow, options: DragOptions): void;
  /** Stops dragging `win` (no-op if it is not being dragged) and runs its `onEnd`. */
  end(win: BrowserWindow): void;
  /** Stops dragging `win` without running `onEnd`. */
  cancel(win: BrowserWindow): void;
  isDragging(win: BrowserWindow): boolean;
  destroy(): void;
}

/** The part of Electron's `screen` the drag needs (injectable for tests). */
export type DragScreen = Pick<Electron.Screen, 'getCursorScreenPoint' | 'getDisplayNearestPoint'>;

interface DragSession {
  win: BrowserWindow;
  options: DragOptions;
  offset: Point;
  size: Size;
  last: Rectangle;
  interval: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
  onClosed: () => void;
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Moves frameless windows with the mouse from the main process. `-webkit-app-region: drag`
 * would do it natively, but it swallows hover and clicks on everything it covers (and the
 * picture-in-picture is all drag area). The renderer calls `start` on pointerdown and `end` on
 * pointerup; meanwhile the cursor is polled and the window follows it, keeping the grab offset.
 */
export function createWindowDrag(screenApi: DragScreen = screen): WindowDrag {
  let session: DragSession | null = null;

  function stop(): DragSession | null {
    const current = session;
    if (!current) return null;
    session = null;
    clearInterval(current.interval);
    clearTimeout(current.timeout);
    if (!current.win.isDestroyed()) current.win.removeListener('closed', current.onClosed);
    return current;
  }

  function tick(): void {
    const current = session;
    if (!current) return;
    if (current.win.isDestroyed()) {
      stop();
      return;
    }
    const cursor = screenApi.getCursorScreenPoint();
    const area = screenApi.getDisplayNearestPoint(cursor).workArea;
    const next = dragBounds(cursor, current.offset, current.size, area, current.options.mode);
    if (sameRect(next, current.last)) return;
    current.last = next;
    // setBounds (not setPosition) re-asserts the size, so crossing displays with different
    // scale factors cannot make the window drift in size.
    current.win.setBounds(next);
  }

  function end(win: BrowserWindow): void {
    if (session?.win !== win) return;
    const finished = stop();
    if (!finished || win.isDestroyed()) return;
    finished.options.onEnd?.(win.getBounds());
  }

  return {
    start(win, options) {
      stop();
      if (win.isDestroyed() || win.isFullScreen() || win.isMaximized()) return;
      const cursor = screenApi.getCursorScreenPoint();
      const bounds = win.getBounds();
      const onClosed = (): void => {
        if (session?.win === win) stop();
      };
      win.once('closed', onClosed);
      session = {
        win,
        options,
        offset: { x: cursor.x - bounds.x, y: cursor.y - bounds.y },
        size: { width: bounds.width, height: bounds.height },
        last: bounds,
        interval: setInterval(tick, DRAG_POLL_MS),
        timeout: setTimeout(() => {
          logger.warn('drag never ended; stopping it');
          end(win);
        }, DRAG_SAFETY_TIMEOUT_MS),
        onClosed,
      };
    },
    end,
    cancel(win) {
      if (session?.win === win) stop();
    },
    isDragging: (win) => session?.win === win,
    destroy() {
      stop();
    },
  };
}
