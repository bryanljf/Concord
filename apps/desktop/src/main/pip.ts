import {
  BrowserWindow,
  Menu,
  screen,
  type MenuItemConstructorOptions,
  type Point,
  type Rectangle,
} from 'electron';
import { EVENTS } from '../preload/channels';
import type { PipLayout, PipResizeCorner, PipState, PipTarget, Settings } from '../preload/api';
import { log } from './log';
import { resourcePath } from './resources';
import { PIP_TILE_WIDTH_RANGE, type SettingsStore } from './settings';
import type { WindowDrag } from './window-drag';
import {
  createQueuedSender,
  hardenWebContents,
  rendererEntry,
  rendererWebPreferences,
  type AppWindow,
  type WindowRegistry,
} from './windows';

export { parsePipTarget } from './validation';

const logger = log('pip');

// ---------------------------------------------------------------------------
// Geometry (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * Space between the window edge and the cameras, and between two cameras: none, the cameras fill
 * the window edge to edge (only the window's corners are rounded, in pip.css).
 */
export const PIP_PADDING = 0;
export const PIP_GAP = 0;
/** Narrowest camera, unless even that does not fit on the screen. */
export const PIP_MIN_TILE_WIDTH = 160;
/** Distance from the screen edges of the default (top-right) position. */
export const PIP_SCREEN_MARGIN = 16;
/** Outside fullscreen the window never covers more than this share of the work area. */
export const PIP_MAX_AREA_FRACTION = 1 / 6;
/** Cursor polling period while resizing (~60 Hz). */
export const PIP_POLL_MS = 16;
/** A resize that never receives `endPipResize` (lost pointerup) stops by itself. */
export const PIP_RESIZE_SAFETY_TIMEOUT_MS = 60_000;
/** "Always on top" re-raises the window this often, over other topmost windows. */
export const PIP_RAISE_INTERVAL_MS = 2_000;
/**
 * Fully transparent: the renderer paints the rounded #111214 box (pip.css). A non-resizable
 * frameless window loses WS_THICKFRAME, and with it Windows 11's native rounded corners, so the
 * corners are drawn in CSS instead (same look on Windows 10).
 */
export const PIP_BACKGROUND = '#00000000';

export interface Size {
  width: number;
  height: number;
}

export interface PipPlacement {
  bounds: Rectangle;
  /** Effective width of each camera (the setting clamped to the screen). */
  tileWidth: number;
}

/** Cameras are 16:9. */
export function pipTileHeight(tileWidth: number): number {
  return Math.round((tileWidth * 9) / 16);
}

/** Window size for `count` cameras of `tileWidth`, stacked along `layout`. */
export function pipContentSize(count: number, tileWidth: number, layout: PipLayout): Size {
  const n = Math.max(1, count);
  const stacked = (tile: number): number => n * tile + (n - 1) * PIP_GAP + 2 * PIP_PADDING;
  const tileHeight = pipTileHeight(tileWidth);
  return layout === 'vertical'
    ? { width: tileWidth + 2 * PIP_PADDING, height: stacked(tileHeight) }
    : { width: stacked(tileWidth), height: tileHeight + 2 * PIP_PADDING };
}

/** Largest integer in [0, upper] for which the monotone predicate `fits` holds (0 if none). */
function largestFitting(fits: (width: number) => boolean, upper = 10_000): number {
  let low = 0;
  let high = upper;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

export interface TileWidthLimits {
  min: number;
  max: number;
}

/**
 * Allowed camera widths for `count` cameras on a display with this work area:
 * - the window must fit inside `box` (default: the whole work area), always;
 * - its area must not exceed 1/6 of the work area, so more cameras means smaller cameras;
 * - cameras are at least `PIP_MIN_TILE_WIDTH` wide, which beats the 1/6 rule but not the fit
 *   (many cameras stacked on a small screen go below the minimum rather than off-screen).
 */
export function pipTileWidthLimits(
  count: number,
  layout: PipLayout,
  workArea: Size,
  box: Size = workArea,
): TileWidthLimits {
  const maxArea = workArea.width * workArea.height * PIP_MAX_AREA_FRACTION;
  const fit = largestFitting((width) => {
    const size = pipContentSize(count, width, layout);
    return size.width <= box.width && size.height <= box.height;
  });
  const byArea = largestFitting((width) => {
    const size = pipContentSize(count, width, layout);
    return size.width * size.height <= maxArea;
  });
  const max = Math.min(fit, Math.max(byArea, PIP_MIN_TILE_WIDTH));
  return { min: Math.min(PIP_MIN_TILE_WIDTH, max), max };
}

export function clampPipTileWidth(width: number, limits: TileWidthLimits): number {
  return Math.round(Math.max(limits.min, Math.min(width, limits.max)));
}

/** Top-right corner of the work area, `PIP_SCREEN_MARGIN` away from both edges. */
export function pipDefaultPosition(size: Size, workArea: Rectangle): Point {
  return {
    x: workArea.x + workArea.width - size.width - PIP_SCREEN_MARGIN,
    y: workArea.y + PIP_SCREEN_MARGIN,
  };
}

/** Moves `rect` (size unchanged) so it lies inside `area`; top/left win if it is too big. */
export function clampRectToArea(rect: Rectangle, area: Rectangle): Rectangle {
  const x = Math.max(area.x, Math.min(rect.x, area.x + area.width - rect.width));
  const y = Math.max(area.y, Math.min(rect.y, area.y + area.height - rect.height));
  return { x: Math.round(x), y: Math.round(y), width: rect.width, height: rect.height };
}

/**
 * The screen quadrant holding the window's centre: the window corner nearest to a screen
 * corner, which stays put when the window grows or shrinks.
 */
export function nearestScreenCorner(rect: Rectangle, area: Rectangle): PipResizeCorner {
  const north = rect.y + rect.height / 2 <= area.y + area.height / 2;
  const west = rect.x + rect.width / 2 <= area.x + area.width / 2;
  if (north) return west ? 'nw' : 'ne';
  return west ? 'sw' : 'se';
}

/** `previous` resized to `size`, growing away from its nearest screen corner, then clamped. */
export function anchoredBounds(previous: Rectangle, size: Size, area: Rectangle): Rectangle {
  const corner = nearestScreenCorner(previous, area);
  const x = corner.endsWith('w') ? previous.x : previous.x + previous.width - size.width;
  const y = corner.startsWith('n') ? previous.y : previous.y + previous.height - size.height;
  return clampRectToArea({ x, y, width: size.width, height: size.height }, area);
}

export interface PipPlacementInput {
  count: number;
  layout: PipLayout;
  /** `settings.pipTileWidth`, clamped here to the display. */
  tileWidth: number;
  /** `settings.pipPosition`: saved top-left, or null for the primary display's top-right. */
  position: Point | null;
  /** Current bounds when re-laying out an open window; null when placing a new one. */
  previous: Rectangle | null;
  primaryWorkArea: Rectangle;
  /** Work area of the display a rectangle belongs to. */
  workAreaFor(rect: Rectangle): Rectangle;
}

/** Where the (non-fullscreen) window goes and how big each camera is. */
export function placePip(input: PipPlacementInput): PipPlacement {
  const { count, layout } = input;
  const sized = (area: Rectangle): { tileWidth: number; size: Size } => {
    const limits = pipTileWidthLimits(count, layout, area);
    const tileWidth = clampPipTileWidth(input.tileWidth, limits);
    return { tileWidth, size: pipContentSize(count, tileWidth, layout) };
  };

  if (input.position === null) {
    const area = input.primaryWorkArea;
    const { tileWidth, size } = sized(area);
    const corner = pipDefaultPosition(size, area);
    return { tileWidth, bounds: clampRectToArea({ ...corner, ...size }, area) };
  }
  if (input.previous) {
    const area = input.workAreaFor(input.previous);
    const { tileWidth, size } = sized(area);
    return { tileWidth, bounds: anchoredBounds(input.previous, size, area) };
  }
  const { x, y } = input.position;
  const area = input.workAreaFor({ x, y, width: 1, height: 1 });
  const { tileWidth, size } = sized(area);
  return { tileWidth, bounds: clampRectToArea({ x, y, ...size }, area) };
}

export interface PipResizeInput {
  /** Corner being dragged; the opposite one stays fixed. */
  corner: PipResizeCorner;
  /** Bounds when the resize started. */
  start: Rectangle;
  cursor: Point;
  count: number;
  layout: PipLayout;
  workArea: Rectangle;
}

/** Bounds and camera width while a corner follows the cursor (16:9 kept, limits applied). */
export function resizePip(input: PipResizeInput): PipPlacement {
  const { corner, start, cursor, count, layout, workArea } = input;
  const n = Math.max(1, count);
  const west = corner.endsWith('w');
  const north = corner.startsWith('n');
  const fixedX = west ? start.x + start.width : start.x;
  const fixedY = north ? start.y + start.height : start.y;
  const width = west ? fixedX - cursor.x : cursor.x - fixedX;
  const height = north ? fixedY - cursor.y : cursor.y - fixedY;

  // Camera width implied by each axis; the larger wins, so the window follows whichever
  // direction the cursor moved most.
  const along = (length: number): number => (length - 2 * PIP_PADDING - (n - 1) * PIP_GAP) / n;
  const fromWidth = layout === 'vertical' ? width - 2 * PIP_PADDING : along(width);
  const tileHeight = layout === 'vertical' ? along(height) : height - 2 * PIP_PADDING;
  const fromHeight = (tileHeight * 16) / 9;

  // Room between the fixed corner and the work area edges, in the direction it grows.
  const box: Size = {
    width: Math.max(start.width, west ? fixedX - workArea.x : workArea.x + workArea.width - fixedX),
    height: Math.max(
      start.height,
      north ? fixedY - workArea.y : workArea.y + workArea.height - fixedY,
    ),
  };
  const limits = pipTileWidthLimits(n, layout, workArea, box);
  const tileWidth = clampPipTileWidth(Math.max(fromWidth, fromHeight), limits);
  const size = pipContentSize(n, tileWidth, layout);
  const bounds: Rectangle = {
    x: west ? fixedX - size.width : fixedX,
    y: north ? fixedY - size.height : fixedY,
    width: size.width,
    height: size.height,
  };
  return { tileWidth, bounds: clampRectToArea(bounds, workArea) };
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function samePoint(a: Point | null, b: Point | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y;
}

function center(rect: Rectangle): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export interface PipDeps {
  registry: WindowRegistry;
  settings: SettingsStore;
  drag: WindowDrag;
  /** "Abrir o Concord" in the menu. */
  showMainWindow(): void;
}

export interface PipManager {
  /** Creates the window with these cameras, or re-targets it and brings it to the front. */
  open(target: PipTarget): void;
  /** New camera list while open (no-op when closed); an empty list closes the window. */
  update(target: PipTarget): void;
  close(): void;
  getState(): PipState;
  /** What the window shows; null when it is closed. */
  getTarget(): PipTarget | null;
  /** `startWindowDrag` from the PiP renderer (ignored in fullscreen or while resizing). */
  startDrag(): void;
  showMenu(): void;
  startResize(corner: PipResizeCorner): void;
  endResize(): void;
  setFullscreen(enabled: boolean): void;
  /** Closes without ceremony (app quit). */
  destroy(): void;
}

interface ResizeSession {
  corner: PipResizeCorner;
  start: Rectangle;
  workArea: Rectangle;
  tileWidth: number;
  interval: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * The cameras' picture-in-picture: one small frameless window, re-targeted like the pop-out.
 * It must never take focus away from a game, so it is created non-focusable, shown with
 * `showInactive()` and moved/resized from here (the renderer reports pointer down/up and the
 * cursor is polled). It is hidden from captures and from the capture picker.
 */
export function createPipManager(deps: PipDeps): PipManager {
  let current: AppWindow | null = null;
  let target: PipTarget | null = null;
  /** Bounds to go back to while the window covers the whole display. */
  let fullscreenRestore: Rectangle | null = null;
  let resize: ResizeSession | null = null;
  let raiseTimer: ReturnType<typeof setInterval> | null = null;
  let menuOpen = false;
  let unbindScreen: (() => void) | null = null;

  function alive(): AppWindow | null {
    return current && !current.browserWindow.isDestroyed() ? current : null;
  }

  function workAreaFor(rect: Rectangle): Rectangle {
    return screen.getDisplayNearestPoint(center(rect)).workArea;
  }

  function placement(previous: Rectangle | null): PipPlacement {
    const settings = deps.settings.get();
    return placePip({
      count: target?.participantIds.length ?? 1,
      layout: settings.pipLayout,
      tileWidth: settings.pipTileWidth,
      position: settings.pipPosition,
      previous,
      primaryWorkArea: screen.getPrimaryDisplay().workArea,
      workAreaFor,
    });
  }

  function savePosition(bounds: Rectangle): void {
    if (samePoint(deps.settings.get().pipPosition, bounds)) return;
    deps.settings.update({ pipPosition: { x: bounds.x, y: bounds.y } });
  }

  /**
   * Applies new bounds; once the user placed the window, `pipPosition` follows its top-left.
   * From inside a settings listener the save waits for the current notification to finish,
   * otherwise the listeners after ours would see the two updates in the wrong order.
   */
  function applyBounds(win: BrowserWindow, bounds: Rectangle, inSettingsListener = false): void {
    if (!sameRect(win.getBounds(), bounds)) win.setBounds(bounds);
    if (deps.settings.get().pipPosition === null) return;
    if (!inSettingsListener) {
      savePosition(bounds);
      return;
    }
    const window = current;
    queueMicrotask(() => {
      if (window && alive() === window && deps.settings.get().pipPosition !== null) {
        savePosition(window.browserWindow.getBounds());
      }
    });
  }

  /** Re-fits the window to the camera count and settings (deferred while busy). */
  function relayout(): void {
    const window = alive();
    if (!window || fullscreenRestore || resize) return;
    const win = window.browserWindow;
    if (deps.drag.isDragging(win)) return;
    applyBounds(win, placement(win.getBounds()).bounds);
  }

  function stopRaising(): void {
    if (raiseTimer) clearInterval(raiseTimer);
    raiseTimer = null;
  }

  /**
   * On: topmost at the highest level (above the taskbar) and re-raised every 2 s, so it stays
   * over borderless fullscreen games that are topmost too. Off: a regular window, since on
   * Windows every always-on-top level is just "topmost".
   */
  function applyAlwaysOnTop(): void {
    stopRaising();
    const window = alive();
    if (!window) return;
    const win = window.browserWindow;
    if (!deps.settings.get().pipAlwaysOnTop) {
      win.setAlwaysOnTop(false);
      return;
    }
    win.setAlwaysOnTop(true, 'screen-saver');
    raiseTimer = setInterval(() => {
      // Never above our own context menu.
      if (!win.isDestroyed() && win.isVisible() && !menuOpen) win.moveTop();
    }, PIP_RAISE_INTERVAL_MS);
  }

  function stopResize(): ResizeSession | null {
    const session = resize;
    if (!session) return null;
    resize = null;
    clearInterval(session.interval);
    clearTimeout(session.timeout);
    return session;
  }

  function tickResize(): void {
    const window = alive();
    const session = resize;
    if (!window || !session) {
      stopResize();
      return;
    }
    const { bounds, tileWidth } = resizePip({
      corner: session.corner,
      start: session.start,
      cursor: screen.getCursorScreenPoint(),
      count: target?.participantIds.length ?? 1,
      layout: deps.settings.get().pipLayout,
      workArea: session.workArea,
    });
    session.tileWidth = tileWidth;
    const win = window.browserWindow;
    if (!sameRect(win.getBounds(), bounds)) win.setBounds(bounds);
  }

  function endResize(): void {
    const session = stopResize();
    const window = alive();
    if (!session || !window) return;
    const bounds = window.browserWindow.getBounds();
    // A click on a handle without moving keeps "top-right corner" (null) as it is.
    if (sameRect(bounds, session.start)) return;
    const tileWidth = Math.max(
      PIP_TILE_WIDTH_RANGE.min,
      Math.min(session.tileWidth, PIP_TILE_WIDTH_RANGE.max),
    );
    deps.settings.update({ pipTileWidth: tileWidth, pipPosition: { x: bounds.x, y: bounds.y } });
  }

  function setFullscreen(enabled: boolean): void {
    const window = alive();
    if (!window || enabled === (fullscreenRestore !== null)) return;
    const win = window.browserWindow;
    if (enabled) {
      deps.drag.cancel(win);
      stopResize();
      const restore = win.getBounds();
      fullscreenRestore = restore;
      // Not `setFullScreen`: native fullscreen activates the window, stealing the game's focus.
      win.setBounds(screen.getDisplayNearestPoint(center(restore)).bounds);
    } else {
      const restore = fullscreenRestore;
      fullscreenRestore = null;
      // The camera count or the settings may have changed meanwhile.
      applyBounds(win, placement(restore).bounds);
    }
    window.send(EVENTS.PIP_FULLSCREEN, enabled);
    logger.info(`fullscreen: ${enabled}`);
  }

  function onSettingsChanged(next: Settings, previous: Settings): void {
    const window = alive();
    if (!window) return;
    if (next.pipAlwaysOnTop !== previous.pipAlwaysOnTop) applyAlwaysOnTop();
    const positionChanged = !samePoint(next.pipPosition, previous.pipPosition);
    if (
      !positionChanged &&
      next.pipLayout === previous.pipLayout &&
      next.pipTileWidth === previous.pipTileWidth
    ) {
      return;
    }
    // Fullscreen exit and the end of a drag or resize re-apply the settings anyway.
    const win = window.browserWindow;
    if (fullscreenRestore || resize || deps.drag.isDragging(win)) return;
    const bounds = win.getBounds();
    // A position that is not where the window already is (e.g. null from "Voltar ao canto
    // superior direito") places it again from scratch.
    const moved = positionChanged && !samePoint(next.pipPosition, bounds);
    applyBounds(win, placement(moved ? null : bounds).bounds, true);
  }

  function bindScreen(): () => void {
    const onDisplaysChanged = (): void => relayout();
    screen.on('display-metrics-changed', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);
    return () => {
      screen.removeListener('display-metrics-changed', onDisplaysChanged);
      screen.removeListener('display-removed', onDisplaysChanged);
    };
  }

  function teardown(): void {
    stopResize();
    stopRaising();
    unbindScreen?.();
    unbindScreen = null;
    fullscreenRestore = null;
    menuOpen = false;
    current = null;
    target = null;
  }

  function create(first: PipTarget): AppWindow {
    const { bounds } = placement(null);
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: PIP_BACKGROUND,
      title: 'Concord — câmeras',
      icon: resourcePath('icon.png'),
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      // Never takes focus (games keep the keyboard); on Windows this also hides it from the
      // taskbar. Must never be flipped at runtime with setFocusable().
      focusable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      webPreferences: rendererWebPreferences('pip'),
    });
    // Before the first frame: the PiP must never show up in the user's own live or in prints.
    win.setContentProtection(true);
    const entry = rendererEntry();
    const send = createQueuedSender(win);
    const window: AppWindow = { kind: 'pip', browserWindow: win, send };
    current = window;

    win.once('ready-to-show', () => {
      if (!win.isDestroyed()) win.showInactive();
    });
    hardenWebContents(win, entry.appOrigin);
    // A reloaded renderer starts without knowing it covers the screen.
    win.webContents.on('did-finish-load', () => {
      if (current === window && fullscreenRestore) send(EVENTS.PIP_FULLSCREEN, true);
    });
    win.on('closed', () => {
      if (current !== window) return;
      teardown();
      deps.registry.broadcast(EVENTS.PIP_STATE, { open: false } satisfies PipState);
      logger.info('closed');
    });
    deps.registry.add(window);
    applyAlwaysOnTop();
    unbindScreen = bindScreen();
    // Queued until the renderer has loaded.
    send(EVENTS.PIP_TARGET, first);
    void entry.load(win);
    deps.registry.broadcast(EVENTS.PIP_STATE, { open: true } satisfies PipState);
    logger.info(`created with ${first.participantIds.length} camera(s) in #${first.room}`);
    return window;
  }

  function close(): void {
    alive()?.browserWindow.close();
  }

  function retarget(window: AppWindow, next: PipTarget): void {
    target = next;
    window.send(EVENTS.PIP_TARGET, next);
    relayout();
  }

  function showMenu(): void {
    const window = alive();
    if (!window || menuOpen) return;
    const settings = deps.settings.get();
    const update = (patch: Partial<Settings>): void => {
      deps.settings.update(patch);
    };
    const template: MenuItemConstructorOptions[] = [
      {
        label: 'Por cima de tudo (inclusive tela cheia)',
        type: 'checkbox',
        checked: settings.pipAlwaysOnTop,
        click: (item) => update({ pipAlwaysOnTop: item.checked }),
      },
      {
        label: 'Tela cheia',
        type: 'checkbox',
        checked: fullscreenRestore !== null,
        click: (item) => setFullscreen(item.checked),
      },
      {
        label: 'Disposição',
        submenu: [
          {
            label: 'Vertical',
            type: 'radio',
            checked: settings.pipLayout === 'vertical',
            click: () => update({ pipLayout: 'vertical' }),
          },
          {
            label: 'Horizontal',
            type: 'radio',
            checked: settings.pipLayout === 'horizontal',
            click: () => update({ pipLayout: 'horizontal' }),
          },
        ],
      },
      {
        label: 'Voltar ao canto superior direito',
        click: () => {
          update({ pipPosition: null });
          // Leaving fullscreen re-places the window from the (now null) position.
          setFullscreen(false);
        },
      },
      { type: 'separator' },
      { label: 'Abrir o Concord', click: () => deps.showMainWindow() },
      { label: 'Fechar picture-in-picture', click: () => close() },
    ];
    menuOpen = true;
    Menu.buildFromTemplate(template).popup({
      window: window.browserWindow,
      callback: () => {
        menuOpen = false;
      },
    });
  }

  const unsubscribeSettings = deps.settings.onChange(onSettingsChanged);

  return {
    open(next) {
      if (next.participantIds.length === 0) {
        close();
        return;
      }
      const window = alive();
      if (!window) {
        target = next;
        create(next);
        return;
      }
      retarget(window, next);
      const win = window.browserWindow;
      win.showInactive();
      win.moveTop();
      logger.info(`showing ${next.participantIds.length} camera(s) in #${next.room}`);
    },
    update(next) {
      const window = alive();
      if (!window) return;
      if (next.participantIds.length === 0) {
        close();
        return;
      }
      retarget(window, next);
    },
    close,
    getState: () => ({ open: alive() !== null }),
    getTarget: () => (alive() ? target : null),
    startDrag() {
      const window = alive();
      if (!window || fullscreenRestore || resize) return;
      const start = window.browserWindow.getBounds();
      deps.drag.start(window.browserWindow, {
        mode: 'inside',
        onEnd: (bounds) => {
          // A plain click (pointerdown + pointerup, double-click...) is not a placement.
          if (sameRect(bounds, start)) return;
          savePosition(bounds);
          // Another display may allow a different maximum size.
          relayout();
        },
      });
    },
    showMenu,
    startResize(corner) {
      const window = alive();
      if (!window || fullscreenRestore) return;
      const win = window.browserWindow;
      deps.drag.cancel(win);
      stopResize();
      const start = win.getBounds();
      resize = {
        corner,
        start,
        workArea: workAreaFor(start),
        tileWidth: deps.settings.get().pipTileWidth,
        interval: setInterval(tickResize, PIP_POLL_MS),
        timeout: setTimeout(() => {
          logger.warn('resize never ended; stopping it');
          endResize();
        }, PIP_RESIZE_SAFETY_TIMEOUT_MS),
      };
    },
    endResize,
    setFullscreen,
    destroy() {
      unsubscribeSettings();
      const window = alive();
      teardown();
      window?.browserWindow.destroy();
    },
  };
}
