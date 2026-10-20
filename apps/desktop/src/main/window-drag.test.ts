import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ screen: {} }));

import type { BrowserWindow, Display, Rectangle } from 'electron';
import {
  createWindowDrag,
  dragBounds,
  DRAG_MIN_VISIBLE,
  DRAG_POLL_MS,
  DRAG_SAFETY_TIMEOUT_MS,
} from './window-drag';

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const SECOND = { x: 1920, y: 0, width: 1280, height: 984 };
const size = { width: 400, height: 300 };

describe('dragBounds', () => {
  it('keeps the grab offset', () => {
    expect(dragBounds({ x: 500, y: 400 }, { x: 50, y: 10 }, size, AREA, 'inside')).toEqual({
      x: 450,
      y: 390,
      ...size,
    });
  });

  it('inside: the whole window stays in the work area', () => {
    expect(dragBounds({ x: -100, y: 2000 }, { x: 50, y: 10 }, size, AREA, 'inside')).toEqual({
      x: 0,
      y: 1040 - 300,
      ...size,
    });
    expect(dragBounds({ x: 3000, y: -50 }, { x: 0, y: 0 }, size, SECOND, 'inside')).toEqual({
      x: 3200 - 400,
      y: 0,
      ...size,
    });
  });

  it('reachable: may leave the screen but keeps the top edge and a strip visible', () => {
    expect(dragBounds({ x: -1000, y: 2000 }, { x: 0, y: 0 }, size, AREA, 'reachable')).toEqual({
      x: -400 + DRAG_MIN_VISIBLE,
      y: 1040 - DRAG_MIN_VISIBLE,
      ...size,
    });
    expect(dragBounds({ x: 5000, y: -300 }, { x: 0, y: 0 }, size, AREA, 'reachable')).toEqual({
      x: 1920 - DRAG_MIN_VISIBLE,
      y: 0,
      ...size,
    });
  });
});

function fakeWindow(bounds: Rectangle) {
  let current = { ...bounds };
  let destroyed = false;
  const listeners = new Map<string, () => void>();
  const win = {
    isDestroyed: () => destroyed,
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    getBounds: () => ({ ...current }),
    setBounds: vi.fn((next: Rectangle) => {
      current = { ...next };
    }),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    removeListener: vi.fn((event: string) => listeners.delete(event)),
  };
  return {
    win,
    browserWindow: win as unknown as BrowserWindow,
    close() {
      destroyed = true;
      listeners.get('closed')?.();
    },
  };
}

describe('createWindowDrag', () => {
  let cursor = { x: 0, y: 0 };
  const screen = {
    getCursorScreenPoint: () => ({ ...cursor }),
    getDisplayNearestPoint: (point: { x: number }) =>
      ({ workArea: point.x >= 1920 ? SECOND : AREA }) as Display,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    cursor = { x: 0, y: 0 };
  });
  afterEach(() => vi.useRealTimers());

  it('follows the cursor until end() and reports the final bounds', () => {
    const drag = createWindowDrag(screen);
    const { win, browserWindow } = fakeWindow({ x: 100, y: 100, ...size });
    const onEnd = vi.fn();
    cursor = { x: 150, y: 110 };
    drag.start(browserWindow, { mode: 'inside', onEnd });
    expect(drag.isDragging(browserWindow)).toBe(true);

    cursor = { x: 650, y: 510 };
    vi.advanceTimersByTime(DRAG_POLL_MS);
    expect(win.getBounds()).toEqual({ x: 600, y: 500, ...size });

    // Same cursor: no redundant setBounds.
    vi.advanceTimersByTime(DRAG_POLL_MS * 3);
    expect(win.setBounds).toHaveBeenCalledTimes(1);

    // Onto the second display: clamped to its work area.
    cursor = { x: 3150, y: 10 };
    vi.advanceTimersByTime(DRAG_POLL_MS);
    expect(win.getBounds()).toEqual({ x: 3200 - 400, y: 0, ...size });

    drag.end(browserWindow);
    expect(onEnd).toHaveBeenCalledWith({ x: 2800, y: 0, ...size });
    expect(drag.isDragging(browserWindow)).toBe(false);
    cursor = { x: 0, y: 0 };
    vi.advanceTimersByTime(DRAG_POLL_MS * 3);
    expect(win.setBounds).toHaveBeenCalledTimes(2);
  });

  it('cancel() stops without onEnd; end() on another window is ignored', () => {
    const drag = createWindowDrag(screen);
    const a = fakeWindow({ x: 0, y: 0, ...size });
    const b = fakeWindow({ x: 0, y: 0, ...size });
    const onEnd = vi.fn();
    drag.start(a.browserWindow, { mode: 'inside', onEnd });
    drag.end(b.browserWindow);
    expect(drag.isDragging(a.browserWindow)).toBe(true);
    drag.cancel(a.browserWindow);
    expect(drag.isDragging(a.browserWindow)).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('stops when the window closes, and after the safety timeout', () => {
    const drag = createWindowDrag(screen);
    const closing = fakeWindow({ x: 0, y: 0, ...size });
    const onEnd = vi.fn();
    drag.start(closing.browserWindow, { mode: 'inside', onEnd });
    closing.close();
    expect(drag.isDragging(closing.browserWindow)).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();

    const stuck = fakeWindow({ x: 0, y: 0, ...size });
    drag.start(stuck.browserWindow, { mode: 'reachable', onEnd });
    vi.advanceTimersByTime(DRAG_SAFETY_TIMEOUT_MS);
    expect(drag.isDragging(stuck.browserWindow)).toBe(false);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores fullscreen and maximized windows; a new drag replaces the old one', () => {
    const drag = createWindowDrag(screen);
    const full = fakeWindow({ x: 0, y: 0, ...size });
    full.win.isFullScreen.mockReturnValue(true);
    drag.start(full.browserWindow, { mode: 'inside' });
    expect(drag.isDragging(full.browserWindow)).toBe(false);

    const a = fakeWindow({ x: 0, y: 0, ...size });
    const b = fakeWindow({ x: 0, y: 0, ...size });
    drag.start(a.browserWindow, { mode: 'inside' });
    drag.start(b.browserWindow, { mode: 'inside' });
    expect(drag.isDragging(a.browserWindow)).toBe(false);
    expect(drag.isDragging(b.browserWindow)).toBe(true);
    drag.destroy();
    expect(drag.isDragging(b.browserWindow)).toBe(false);
  });
});
