/**
 * Touch and small-screen helpers (the web client runs this same renderer on phones): the media
 * queries `hooks/useViewport.ts` watches (`styles/*.css` use the same ones), the long press that
 * stands in for the right click (`hooks/useLongPress.ts`), the tap that reveals hover-only
 * controls for a moment (`hooks/useTouchReveal.ts`), the one-column grid of a portrait phone and
 * the fullscreen a `<video>` keeps on iPhones, where the page itself has none. Pure and
 * unit-tested, except `dispatchContextMenu`, which only touches the DOM when a hook asks.
 */
import type { Point } from './contextMenu';
import { TILE_ASPECT } from './gridLayout';

/** Phones: the sidebar becomes a drawer, the grid one column, the panels bottom sheets. */
export const PHONE_QUERY = '(max-width: 767px)';
/** Touch screens: hover-only controls get a tap to reveal them, targets grow to 40 px. */
export const TOUCH_QUERY = '(pointer: coarse)';
export const PORTRAIT_QUERY = '(orientation: portrait)';

/** A finger held this long on a tile opens its menu (what the right click does). */
export const LONG_PRESS_MS = 500;
/** Moving further than this before the time is up is a scroll or a drag, not a press. */
export const LONG_PRESS_MOVE_PX = 10;
/** How long a tap keeps hover-only controls on screen. */
export const TOUCH_REVEAL_MS = 3000;

type TimerHandle = ReturnType<typeof setTimeout>;

/** The clock the helpers run on (the global one; tests pass fake timers through it anyway). */
export interface Timers {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const GLOBAL_TIMERS: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** The finger left the spot it landed on: the press is a scroll or a drag. */
export function movedTooFar(start: Point, current: Point, threshold = LONG_PRESS_MOVE_PX): boolean {
  return distance(start, current) > threshold;
}

export interface LongPressOptions {
  delayMs?: number;
  moveThresholdPx?: number;
  timers?: Timers;
}

export interface LongPress {
  /** The finger landed: the timer starts (a press already on is replaced). */
  down(point: Point): void;
  /** The finger moved: past the threshold the press is off. */
  move(point: Point): void;
  /** The finger lifted, or the browser took the pointer (a scroll): nothing fires any more. */
  up(): void;
  /** Fires right away when the press is still on (the browser's own long-press event came first). */
  fireNow(): boolean;
  /** Forgets everything, `fired` included (another kind of pointer took over). */
  reset(): void;
  /** A press is on and has not fired yet. */
  readonly pending: boolean;
  /** The last press fired (until the next `down` or `reset`). */
  readonly fired: boolean;
}

/**
 * One finger held still for `delayMs` fires `onFire` with the point it landed on. Lifting it or
 * moving it further than `moveThresholdPx` before that cancels the press.
 */
export function createLongPress(
  onFire: (point: Point) => void,
  options: LongPressOptions = {},
): LongPress {
  const delayMs = options.delayMs ?? LONG_PRESS_MS;
  const threshold = options.moveThresholdPx ?? LONG_PRESS_MOVE_PX;
  const timers = options.timers ?? GLOBAL_TIMERS;
  let start: Point | null = null;
  let handle: TimerHandle | null = null;
  let fired = false;

  const clear = (): void => {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
    start = null;
  };

  const fire = (): void => {
    const point = start;
    clear();
    if (point === null) return;
    fired = true;
    onFire(point);
  };

  return {
    down(point) {
      clear();
      fired = false;
      start = point;
      handle = timers.setTimeout(fire, delayMs);
    },
    move(point) {
      if (start !== null && movedTooFar(start, point, threshold)) clear();
    },
    up() {
      clear();
    },
    fireNow() {
      if (start === null) return false;
      fire();
      return true;
    },
    reset() {
      clear();
      fired = false;
    },
    get pending() {
      return start !== null;
    },
    get fired() {
      return fired;
    },
  };
}

export interface RevealTimer {
  readonly revealed: boolean;
  /**
   * A tap: hidden, it reveals and returns true (the tap is spent); shown, it keeps the controls
   * a while longer and returns false (the tap acts).
   */
  tap(): boolean;
  /** Shows (or keeps showing) for the duration again. */
  show(): void;
  hide(): void;
}

/**
 * Hover-only controls on a touch screen: a tap shows them for `durationMs`, the next tap acts
 * on them. `onChange` gets every change of `revealed` (a React state setter in the hook).
 */
export function createRevealTimer(
  onChange: (revealed: boolean) => void,
  durationMs = TOUCH_REVEAL_MS,
  timers: Timers = GLOBAL_TIMERS,
): RevealTimer {
  let revealed = false;
  let handle: TimerHandle | null = null;

  const clear = (): void => {
    if (handle !== null) {
      timers.clearTimeout(handle);
      handle = null;
    }
  };
  const set = (value: boolean): void => {
    if (revealed === value) return;
    revealed = value;
    onChange(value);
  };
  const hide = (): void => {
    clear();
    set(false);
  };
  const show = (): void => {
    clear();
    set(true);
    handle = timers.setTimeout(hide, durationMs);
  };

  return {
    get revealed() {
      return revealed;
    },
    tap() {
      const spent = !revealed;
      show();
      return spent;
    },
    show,
    hide,
  };
}

/** Columns of the stage grid: one on a phone held upright, the usual two everywhere else. */
export function gridColumns(phone: boolean, portrait: boolean): 1 | 2 {
  return phone && portrait ? 1 : 2;
}

/** One 16:9 tile per row, as wide as the box allows (whole pixels, like `fitGrid`). */
export function fitColumn(width: number): { tileWidth: number; tileHeight: number } {
  const tileWidth = Math.max(0, Math.floor(width));
  return { tileWidth, tileHeight: Math.floor(tileWidth / TILE_ASPECT) };
}

/** What the fullscreen choice looks at (plain objects in tests). */
export interface FullscreenDocument {
  fullscreenEnabled?: boolean;
}

/** A `<video>` (or a stand-in) that may have Safari's own fullscreen. */
export interface FullscreenVideo {
  webkitEnterFullscreen?: unknown;
}

/**
 * Whether the tile's fullscreen button must use the video's own fullscreen: the page cannot go
 * fullscreen (Safari on iPhone) but the `<video>` still can, through `webkitEnterFullscreen()`.
 */
export function usesVideoFullscreen(doc: FullscreenDocument, video: object | null): boolean {
  if (doc.fullscreenEnabled === true) return false;
  return video !== null && typeof (video as FullscreenVideo).webkitEnterFullscreen === 'function';
}

/**
 * Opens the tile's menu where the finger is: a `contextmenu` event from the right button, so the
 * tile's own `onContextMenu` handler (`hooks/useContextMenu.ts`) places it at the point.
 */
export function dispatchContextMenu(element: HTMLElement, point: Point): void {
  element.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      button: 2,
    }),
  );
}
