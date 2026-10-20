import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Rectangle } from 'electron';

const mocks = vi.hoisted(() => {
  class FakeWindow {
    static instances: FakeWindow[] = [];
    readonly options: Record<string, unknown>;
    bounds: { x: number; y: number; width: number; height: number };
    destroyed = false;
    visible = false;
    readonly calls: string[] = [];
    private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
    readonly webContents = {
      on: vi.fn(),
      send: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };

    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.bounds = {
        x: options.x as number,
        y: options.y as number,
        width: options.width as number,
        height: options.height as number,
      };
      FakeWindow.instances.push(this);
    }

    isDestroyed = (): boolean => this.destroyed;
    isVisible = (): boolean => this.visible;
    isFullScreen = (): boolean => false;
    isMaximized = (): boolean => false;
    getBounds = () => ({ ...this.bounds });
    setBounds = vi.fn((bounds: Partial<FakeWindow['bounds']>) => {
      this.bounds = { ...this.bounds, ...bounds };
    });
    setContentProtection = vi.fn(() => this.calls.push('setContentProtection'));
    setAlwaysOnTop = vi.fn();
    showInactive = vi.fn(() => {
      this.calls.push('showInactive');
      this.visible = true;
    });
    moveTop = vi.fn();
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async () => undefined);

    on(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }
    once(event: string, listener: (...args: unknown[]) => void): this {
      return this.on(event, listener);
    }
    removeListener(event: string, listener: (...args: unknown[]) => void): this {
      this.listeners.set(
        event,
        (this.listeners.get(event) ?? []).filter((item) => item !== listener),
      );
      return this;
    }
    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener();
    }
    close(): void {
      this.destroy();
    }
    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
  }
  return {
    FakeWindow,
    cursor: { x: 0, y: 0 },
    popup: vi.fn(),
    templates: [] as unknown[],
  };
});

/** One 1920×1080 display with a 40 px taskbar. */
const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '' },
  shell: { openExternal: vi.fn() },
  BrowserWindow: mocks.FakeWindow,
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => {
      mocks.templates.push(template);
      return { popup: mocks.popup };
    }),
  },
  screen: {
    getPrimaryDisplay: () => ({ bounds: DISPLAY, workArea: AREA }),
    getDisplayNearestPoint: () => ({ bounds: DISPLAY, workArea: AREA }),
    getCursorScreenPoint: () => ({ ...mocks.cursor }),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { EVENTS } from '../preload/channels';
import type { PipLayout, Settings } from '../preload/api';
import {
  anchoredBounds,
  clampRectToArea,
  createPipManager,
  nearestScreenCorner,
  parsePipTarget,
  pipContentSize,
  pipTileWidthLimits,
  placePip,
  PIP_MAX_AREA_FRACTION,
  PIP_MIN_TILE_WIDTH,
  PIP_POLL_MS,
  PIP_RAISE_INTERVAL_MS,
  resizePip,
  type PipPlacementInput,
} from './pip';
import { defaultSettings, sanitizePatch, type SettingsStore } from './settings';
import { IpcValidationError } from './validation';
import { createWindowDrag } from './window-drag';
import type { WindowRegistry } from './windows';

const area = (rect: { width: number; height: number }): number => rect.width * rect.height;

function place(overrides: Partial<PipPlacementInput> = {}) {
  return placePip({
    count: 1,
    layout: 'vertical',
    tileWidth: 320,
    position: null,
    previous: null,
    primaryWorkArea: AREA,
    workAreaFor: () => AREA,
    ...overrides,
  });
}

describe('pipContentSize', () => {
  it('stacks 16:9 cameras edge to edge, no padding or gaps', () => {
    expect(pipContentSize(1, 320, 'vertical')).toEqual({ width: 320, height: 180 });
    expect(pipContentSize(2, 320, 'vertical')).toEqual({ width: 320, height: 360 });
    expect(pipContentSize(2, 320, 'horizontal')).toEqual({ width: 640, height: 180 });
    expect(pipContentSize(3, 160, 'horizontal')).toEqual({ width: 480, height: 90 });
  });

  it('treats zero cameras like one', () => {
    expect(pipContentSize(0, 320, 'vertical')).toEqual(pipContentSize(1, 320, 'vertical'));
  });
});

describe('pipTileWidthLimits', () => {
  it('caps the window at 1/6 of the work area', () => {
    for (const layout of ['vertical', 'horizontal'] as PipLayout[]) {
      for (const count of [1, 2, 3, 4, 6]) {
        const { min, max } = pipTileWidthLimits(count, layout, AREA);
        expect(min).toBe(PIP_MIN_TILE_WIDTH);
        expect(area(pipContentSize(count, max, layout))).toBeLessThanOrEqual(
          area(AREA) * PIP_MAX_AREA_FRACTION,
        );
        // One pixel wider breaks the 1/6 rule or no longer fits on the screen.
        const bigger = pipContentSize(count, max + 1, layout);
        expect(
          area(bigger) > area(AREA) * PIP_MAX_AREA_FRACTION ||
            bigger.width > AREA.width ||
            bigger.height > AREA.height,
        ).toBe(true);
      }
    }
    // ≈ the 780×440 of the plan once the taskbar is accounted for (768×432).
    expect(pipTileWidthLimits(1, 'vertical', AREA).max).toBe(768);
  });

  it('shrinks each camera as more are added', () => {
    const one = pipTileWidthLimits(1, 'horizontal', AREA).max;
    const four = pipTileWidthLimits(4, 'horizontal', AREA).max;
    expect(four).toBeLessThan(one);
    expect(four).toBe(384);
  });

  it('keeps the 160 px minimum unless it does not fit on the screen', () => {
    // Portrait screen: 11 cameras stacked vertically stay at 160 px although that is just over
    // 1/6 of the work area.
    const portrait = { width: 720, height: 1240 };
    expect(area(pipContentSize(11, 160, 'vertical'))).toBeGreaterThan(
      area(portrait) * PIP_MAX_AREA_FRACTION,
    );
    expect(pipTileWidthLimits(11, 'vertical', portrait)).toEqual({ min: 160, max: 160 });
    // 15 do not: they go below the minimum but stay on screen.
    const limits = pipTileWidthLimits(15, 'vertical', AREA);
    expect(limits.max).toBeLessThan(PIP_MIN_TILE_WIDTH);
    expect(limits.min).toBe(limits.max);
    expect(pipContentSize(15, limits.max, 'vertical').height).toBeLessThanOrEqual(AREA.height);
  });

  it('respects a smaller box (room left from a fixed corner)', () => {
    const { max } = pipTileWidthLimits(1, 'vertical', AREA, { width: 400, height: 1040 });
    expect(max).toBe(400);
  });
});

describe('placePip', () => {
  it('defaults to the top-right corner of the primary work area, 16 px in', () => {
    expect(place()).toEqual({
      tileWidth: 320,
      bounds: { x: 1584, y: 16, width: 320, height: 180 },
    });
    const offset = { x: -1280, y: 200, width: 1280, height: 984 };
    expect(place({ primaryWorkArea: offset }).bounds).toMatchObject({ x: -1280 + 1280 - 320 - 16 });
  });

  it('clamps the tile width to the minimum and to the 1/6 maximum', () => {
    expect(place({ tileWidth: 120 }).tileWidth).toBe(160);
    expect(place({ tileWidth: 4000 }).tileWidth).toBe(768);
  });

  it('uses the saved position, clamped inside the work area of its display', () => {
    expect(place({ position: { x: 100, y: 200 } }).bounds).toEqual({
      x: 100,
      y: 200,
      width: 320,
      height: 180,
    });
    expect(place({ position: { x: 5000, y: -50 } }).bounds).toEqual({
      x: 1920 - 320,
      y: 0,
      width: 320,
      height: 180,
    });
  });

  it('applies the 1/6 rule of the display the window is on', () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 984 };
    const workAreaFor = (rect: Rectangle) => (rect.x >= 1920 ? secondary : AREA);
    const placed = place({ position: { x: 2000, y: 100 }, tileWidth: 4000, workAreaFor });
    expect(placed.bounds.x).toBe(2000);
    expect(area(placed.bounds)).toBeLessThanOrEqual(area(secondary) * PIP_MAX_AREA_FRACTION);
    expect(placed.tileWidth).toBe(pipTileWidthLimits(1, 'vertical', secondary).max);
  });

  it('grows away from the nearest screen corner when the camera count changes', () => {
    const topRight = place().bounds;
    expect(place({ count: 2, position: { x: 1, y: 1 }, previous: topRight }).bounds).toEqual({
      x: 1584,
      y: 16,
      width: 320,
      height: 360,
    });
    expect(
      place({ count: 2, layout: 'horizontal', position: { x: 1, y: 1 }, previous: topRight })
        .bounds,
    ).toEqual({ x: 1264, y: 16, width: 640, height: 180 });

    const bottomLeft = { x: 16, y: 844, width: 320, height: 180 };
    expect(place({ count: 2, position: { x: 16, y: 844 }, previous: bottomLeft }).bounds).toEqual({
      x: 16,
      y: 664,
      width: 320,
      height: 360,
    });
  });

  it('keeps the top-right corner when the position is null, whatever the previous bounds', () => {
    const previous = { x: 300, y: 300, width: 320, height: 180 };
    expect(place({ count: 2, previous }).bounds).toEqual({
      x: 1584,
      y: 16,
      width: 320,
      height: 360,
    });
  });
});

describe('corner helpers', () => {
  it('picks the quadrant of the window centre', () => {
    const at = (x: number, y: number) => ({ x, y, width: 100, height: 100 });
    expect(nearestScreenCorner(at(0, 0), AREA)).toBe('nw');
    expect(nearestScreenCorner(at(1800, 0), AREA)).toBe('ne');
    expect(nearestScreenCorner(at(0, 900), AREA)).toBe('sw');
    expect(nearestScreenCorner(at(1800, 900), AREA)).toBe('se');
  });

  it('anchors and clamps', () => {
    const bottomRight = { x: 1500, y: 800, width: 400, height: 200 };
    expect(anchoredBounds(bottomRight, { width: 200, height: 100 }, AREA)).toEqual({
      x: 1700,
      y: 900,
      width: 200,
      height: 100,
    });
    // Growing past the left edge is pushed back inside.
    const topLeft = { x: 10, y: 10, width: 100, height: 100 };
    expect(anchoredBounds(topLeft, { width: 300, height: 100 }, AREA)).toEqual({
      x: 10,
      y: 10,
      width: 300,
      height: 100,
    });
    expect(clampRectToArea({ x: -50, y: 2000, width: 300, height: 100 }, AREA)).toEqual({
      x: 0,
      y: 940,
      width: 300,
      height: 100,
    });
  });
});

describe('resizePip', () => {
  const start = { x: 1584, y: 16, width: 320, height: 180 };
  const resize = (cursor: { x: number; y: number }, corner: 'nw' | 'ne' | 'sw' | 'se' = 'sw') =>
    resizePip({ corner, start, cursor, count: 1, layout: 'vertical', workArea: AREA });

  it('keeps the opposite corner fixed and the 16:9 ratio', () => {
    // Bottom-left handle: the top-right corner (1904, 16) stays.
    expect(resize({ x: 1404, y: 216 })).toEqual({
      tileWidth: 500,
      bounds: { x: 1404, y: 16, width: 500, height: 281 },
    });
  });

  it('follows the axis the cursor moved most', () => {
    // Barely wider but much taller: the height decides.
    const { tileWidth } = resize({ x: 1500, y: 16 + 400 });
    expect(tileWidth).toBe(Math.round((400 * 16) / 9));
  });

  it('clamps to the minimum and to the 1/6 maximum', () => {
    expect(resize({ x: 2000, y: 0 })).toEqual({
      tileWidth: 160,
      bounds: { x: 1904 - 160, y: 16, width: 160, height: 90 },
    });
    const big = resize({ x: 0, y: 1040 });
    expect(big.tileWidth).toBe(768);
    expect(big.bounds).toEqual({ x: 1904 - 768, y: 16, width: 768, height: 432 });
  });

  it('never pushes the fixed corner: growth stops at the work area edge', () => {
    const topLeft = { x: 0, y: 0, width: 320, height: 180 };
    // Dragging the top-left handle of a window already in the top-left corner cannot grow it.
    const result = resizePip({
      corner: 'nw',
      start: topLeft,
      cursor: { x: -500, y: -500 },
      count: 1,
      layout: 'vertical',
      workArea: AREA,
    });
    expect(result.bounds).toEqual(topLeft);
  });

  it('handles the horizontal layout', () => {
    const result = resizePip({
      corner: 'se',
      start: { x: 100, y: 100, width: 640, height: 180 },
      cursor: { x: 940, y: 200 },
      count: 2,
      layout: 'horizontal',
      workArea: AREA,
    });
    expect(result).toEqual({
      tileWidth: 420,
      bounds: { x: 100, y: 100, width: 840, height: 236 },
    });
  });
});

describe('parsePipTarget', () => {
  it('accepts a room and up to 15 user ids, deduplicated in order', () => {
    expect(parsePipTarget({ room: 'jogos', participantIds: ['ana', 'bia', 'ana'] })).toEqual({
      room: 'jogos',
      participantIds: ['ana', 'bia'],
    });
    expect(parsePipTarget({ room: 'jogos', participantIds: [], extra: 1 })).toEqual({
      room: 'jogos',
      participantIds: [],
    });
    const fifteen = Array.from({ length: 15 }, (_, i) => `user${i}`);
    expect(parsePipTarget({ room: 'jogos', participantIds: fifteen }).participantIds).toEqual(
      fifteen,
    );
  });

  it('rejects bad shapes', () => {
    const bad = [
      null,
      'jogos',
      { room: 'jogos' },
      { room: 'sala inválida', participantIds: [] },
      { room: 'jogos', participantIds: 'ana' },
      { room: 'jogos', participantIds: [7] },
      { room: 'jogos', participantIds: ['ana#camera'] },
      { room: 'jogos', participantIds: ['ana~pip'] },
      { room: 'jogos', participantIds: ['Ana'] },
      { room: 'jogos', participantIds: ['a'] },
      { room: 'jogos', participantIds: Array.from({ length: 16 }, (_, i) => `user${i}`) },
    ];
    for (const value of bad) expect(() => parsePipTarget(value)).toThrow(IpcValidationError);
  });
});

// ---------------------------------------------------------------------------
// Manager (fake BrowserWindow / screen)
// ---------------------------------------------------------------------------

function fakeSettings(initial: Partial<Settings> = {}) {
  let current: Settings = { ...defaultSettings(), ...initial };
  const listeners = new Set<(next: Settings, previous: Settings) => void>();
  const store = {
    get: () => current,
    update: vi.fn((patch: Partial<Settings>) => {
      const previous = current;
      current = { ...current, ...sanitizePatch(patch) };
      for (const listener of listeners) listener(current, previous);
      return current;
    }),
    onChange(listener: (next: Settings, previous: Settings) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return store as typeof store & SettingsStore;
}

function setup(initial: Partial<Settings> = {}) {
  const settings = fakeSettings(initial);
  const registry = {
    add: vi.fn(() => () => undefined),
    broadcast: vi.fn(),
  } as unknown as WindowRegistry & { broadcast: ReturnType<typeof vi.fn> };
  const drag = createWindowDrag({
    getCursorScreenPoint: () => ({ ...mocks.cursor }),
    getDisplayNearestPoint: () => ({ workArea: AREA }) as Electron.Display,
  });
  const showMainWindow = vi.fn();
  const pip = createPipManager({ registry, settings, drag, showMainWindow });
  const win = () => {
    const last = mocks.FakeWindow.instances.at(-1);
    if (!last) throw new Error('no window');
    return last;
  };
  return { settings, registry, drag, pip, win, showMainWindow };
}

const target = (...participantIds: string[]) => ({ room: 'jogos', participantIds });

describe('createPipManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.FakeWindow.instances.length = 0;
    mocks.templates.length = 0;
    mocks.popup.mockReset();
    mocks.cursor = { x: 0, y: 0 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a protected, non-focusable window in the top-right corner', () => {
    const { pip, registry, win } = setup();
    pip.open(target('ana'));
    const w = win();
    expect(w.options).toMatchObject({
      x: 1584,
      y: 16,
      width: 320,
      height: 180,
      frame: false,
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      fullscreenable: false,
      show: false,
    });
    expect(w.options).not.toHaveProperty('thickFrame');
    expect(w.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(registry.broadcast).toHaveBeenCalledWith(EVENTS.PIP_STATE, { open: true });
    expect(pip.getState()).toEqual({ open: true });
    expect(pip.getTarget()).toEqual(target('ana'));

    w.emit('ready-to-show');
    expect(w.calls).toEqual(['setContentProtection', 'showInactive']);
  });

  it('re-targets the open window, grows from its corner and closes on an empty list', () => {
    const { pip, registry, win } = setup();
    pip.open(target('ana'));
    const w = win();
    pip.update(target('ana', 'bia'));
    expect(mocks.FakeWindow.instances).toHaveLength(1);
    expect(w.getBounds()).toEqual({ x: 1584, y: 16, width: 320, height: 360 });
    expect(pip.getTarget()).toEqual(target('ana', 'bia'));

    pip.open(target('bia'));
    expect(w.moveTop).toHaveBeenCalled();
    expect(w.getBounds()).toEqual({ x: 1584, y: 16, width: 320, height: 180 });

    pip.update(target());
    expect(w.destroyed).toBe(true);
    expect(registry.broadcast).toHaveBeenLastCalledWith(EVENTS.PIP_STATE, { open: false });
    expect(pip.getState()).toEqual({ open: false });
    expect(pip.getTarget()).toBeNull();

    // update() never opens.
    pip.update(target('ana'));
    expect(mocks.FakeWindow.instances).toHaveLength(1);
  });

  it('re-raises every 2 s only while always-on-top is on and the window is visible', () => {
    const { pip, settings, win } = setup();
    pip.open(target('ana'));
    const w = win();
    vi.advanceTimersByTime(PIP_RAISE_INTERVAL_MS);
    expect(w.moveTop).not.toHaveBeenCalled();
    w.emit('ready-to-show');
    vi.advanceTimersByTime(PIP_RAISE_INTERVAL_MS);
    expect(w.moveTop).toHaveBeenCalledTimes(1);

    settings.update({ pipAlwaysOnTop: false });
    expect(w.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(PIP_RAISE_INTERVAL_MS * 3);
    expect(w.moveTop).toHaveBeenCalledTimes(1);
  });

  it('covers the display in fullscreen and restores (re-laid out) afterwards', () => {
    const { pip, win } = setup();
    pip.open(target('ana'));
    const w = win();
    pip.setFullscreen(true);
    expect(w.getBounds()).toEqual(DISPLAY);
    expect(w.webContents.send).not.toHaveBeenCalledWith(EVENTS.PIP_FULLSCREEN, true); // queued

    // A camera joins meanwhile: nothing moves until fullscreen ends.
    pip.update(target('ana', 'bia'));
    expect(w.getBounds()).toEqual(DISPLAY);
    // Dragging and resizing are ignored in fullscreen.
    pip.startDrag();
    pip.startResize('sw');
    vi.advanceTimersByTime(PIP_POLL_MS * 3);
    expect(w.getBounds()).toEqual(DISPLAY);

    pip.setFullscreen(false);
    expect(w.getBounds()).toEqual({ x: 1584, y: 16, width: 320, height: 360 });
  });

  it('resizes from a corner and saves the width and position at the end', () => {
    const { pip, settings, win } = setup();
    pip.open(target('ana'));
    const w = win();
    pip.startResize('sw');
    mocks.cursor = { x: 1404, y: 216 };
    vi.advanceTimersByTime(PIP_POLL_MS);
    expect(w.getBounds()).toEqual({ x: 1404, y: 16, width: 500, height: 281 });
    pip.endResize();
    expect(settings.get()).toMatchObject({ pipTileWidth: 500, pipPosition: { x: 1404, y: 16 } });
    // Nothing moves afterwards.
    mocks.cursor = { x: 0, y: 0 };
    vi.advanceTimersByTime(PIP_POLL_MS * 3);
    expect(w.getBounds()).toEqual({ x: 1404, y: 16, width: 500, height: 281 });
  });

  it('drags inside the work area and saves the position at the end', () => {
    const { pip, drag, settings, win } = setup();
    pip.open(target('ana'));
    const w = win();
    mocks.cursor = { x: 1600, y: 20 };
    pip.startDrag();
    mocks.cursor = { x: 600, y: 520 };
    vi.advanceTimersByTime(PIP_POLL_MS);
    expect(w.getBounds()).toEqual({ x: 584, y: 516, width: 320, height: 180 });
    mocks.cursor = { x: 600, y: 5000 };
    vi.advanceTimersByTime(PIP_POLL_MS);
    expect(w.getBounds()).toMatchObject({ y: 1040 - 180 });
    drag.end(w as unknown as Electron.BrowserWindow);
    expect(settings.get().pipPosition).toEqual({ x: 584, y: 860 });
  });

  it('does not pin the position on a plain click', () => {
    const { pip, drag, settings, win } = setup();
    pip.open(target('ana'));
    mocks.cursor = { x: 1600, y: 20 };
    pip.startDrag();
    vi.advanceTimersByTime(PIP_POLL_MS * 2);
    drag.end(win() as unknown as Electron.BrowserWindow);
    // Pressing the bottom-left handle exactly where it is.
    mocks.cursor = { x: 1584, y: 16 + 180 };
    pip.startResize('sw');
    vi.advanceTimersByTime(PIP_POLL_MS * 2);
    pip.endResize();
    expect(settings.update).not.toHaveBeenCalled();
    expect(settings.get().pipPosition).toBeNull();
  });

  it('saves a moved top-left only after the current settings notification', async () => {
    const { pip, settings, win } = setup({ pipPosition: { x: 1500, y: 680 } });
    pip.open(target('ana', 'bia'));
    const seen: unknown[] = [];
    settings.onChange((next) => seen.push(next.pipPosition));
    // Bottom-right quadrant: switching to horizontal grows up and to the left.
    settings.update({ pipLayout: 'horizontal' });
    expect(win().getBounds()).toEqual({ x: 1180, y: 860, width: 640, height: 180 });
    expect(seen).toEqual([{ x: 1500, y: 680 }]);
    await Promise.resolve();
    expect(seen).toEqual([
      { x: 1500, y: 680 },
      { x: 1180, y: 860 },
    ]);
  });

  it('follows settings: layout, and back to the top-right corner', () => {
    const { pip, settings, win } = setup({ pipPosition: { x: 100, y: 100 } });
    pip.open(target('ana', 'bia'));
    const w = win();
    expect(w.getBounds()).toEqual({ x: 100, y: 100, width: 320, height: 360 });
    settings.update({ pipLayout: 'horizontal' });
    expect(w.getBounds()).toEqual({ x: 100, y: 100, width: 640, height: 180 });
    settings.update({ pipPosition: null });
    expect(w.getBounds()).toEqual({ x: 1920 - 640 - 16, y: 16, width: 640, height: 180 });
  });

  it('shows one native menu at a time', () => {
    const { pip, settings, showMainWindow } = setup();
    pip.open(target('ana'));
    pip.showMenu();
    pip.showMenu();
    expect(mocks.popup).toHaveBeenCalledTimes(1);
    const options = mocks.popup.mock.calls[0]?.[0] as { callback: () => void };
    options.callback();
    pip.showMenu();
    expect(mocks.popup).toHaveBeenCalledTimes(2);

    type Item = {
      label?: string;
      checked?: boolean;
      submenu?: Item[];
      click?: (item: Item) => void;
    };
    const items = mocks.templates[0] as Item[];
    expect(items.map((item) => item.label ?? '---')).toEqual([
      'Por cima de tudo (inclusive tela cheia)',
      'Tela cheia',
      'Disposição',
      'Voltar ao canto superior direito',
      '---',
      'Abrir o Concord',
      'Fechar picture-in-picture',
    ]);
    items[0]?.click?.({ checked: false });
    expect(settings.get().pipAlwaysOnTop).toBe(false);
    items[2]?.submenu?.[1]?.click?.({});
    expect(settings.get().pipLayout).toBe('horizontal');
    items[5]?.click?.({});
    expect(showMainWindow).toHaveBeenCalled();
    items[6]?.click?.({});
    expect(pip.getState()).toEqual({ open: false });
  });

  it('destroys the window without broadcasting on quit', () => {
    const { pip, registry, win } = setup();
    pip.open(target('ana'));
    registry.broadcast.mockClear();
    pip.destroy();
    expect(win().destroyed).toBe(true);
    expect(registry.broadcast).not.toHaveBeenCalled();
  });
});
