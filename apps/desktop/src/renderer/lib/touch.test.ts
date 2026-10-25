import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLongPress,
  createRevealTimer,
  fitColumn,
  gridColumns,
  LONG_PRESS_MOVE_PX,
  LONG_PRESS_MS,
  movedTooFar,
  TOUCH_REVEAL_MS,
  usesVideoFullscreen,
} from './touch';

describe('movedTooFar', () => {
  it('tolerates the threshold itself and anything inside it', () => {
    expect(movedTooFar({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false);
    expect(movedTooFar({ x: 0, y: 0 }, { x: LONG_PRESS_MOVE_PX, y: 0 })).toBe(false);
    expect(movedTooFar({ x: 10, y: 10 }, { x: 16, y: 18 })).toBe(false);
  });

  it('is a move once the finger left the circle around the start', () => {
    expect(movedTooFar({ x: 0, y: 0 }, { x: 0, y: LONG_PRESS_MOVE_PX + 1 })).toBe(true);
    expect(movedTooFar({ x: 10, y: 10 }, { x: 18, y: 18 })).toBe(true);
    expect(movedTooFar({ x: 0, y: 0 }, { x: 3, y: 0 }, 2)).toBe(true);
  });
});

describe('createLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once with the landing point after the delay, and remembers it fired', () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    press.down({ x: 40, y: 50 });
    expect(press.pending).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(onFire).toHaveBeenCalledWith({ x: 40, y: 50 });
    expect(press.pending).toBe(false);
    expect(press.fired).toBe(true);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('is cancelled by lifting the finger before the delay', () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    press.down({ x: 0, y: 0 });
    vi.advanceTimersByTime(LONG_PRESS_MS - 50);
    press.up();
    expect(press.pending).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onFire).not.toHaveBeenCalled();
    expect(press.fired).toBe(false);
  });

  it('is cancelled by moving further than the threshold, not by a small wobble', () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    press.down({ x: 100, y: 100 });
    press.move({ x: 104, y: 103 });
    expect(press.pending).toBe(true);
    press.move({ x: 100, y: 100 + LONG_PRESS_MOVE_PX + 1 });
    expect(press.pending).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('fires at once on request while pending, and never twice', () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    expect(press.fireNow()).toBe(false);
    press.down({ x: 7, y: 8 });
    expect(press.fireNow()).toBe(true);
    expect(onFire).toHaveBeenCalledWith({ x: 7, y: 8 });
    expect(press.fireNow()).toBe(false);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(press.fired).toBe(true);
  });

  it('a new press replaces the one on, and reset forgets a fired one', () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire, { delayMs: 200 });
    press.down({ x: 1, y: 1 });
    vi.advanceTimersByTime(150);
    press.down({ x: 2, y: 2 });
    vi.advanceTimersByTime(150);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(onFire).toHaveBeenCalledWith({ x: 2, y: 2 });
    expect(press.fired).toBe(true);
    press.reset();
    expect(press.fired).toBe(false);
    expect(press.pending).toBe(false);
  });

  it('runs on the timers it is given', () => {
    const onFire = vi.fn();
    const setTimeout = vi.fn(() => 42 as unknown as ReturnType<typeof globalThis.setTimeout>);
    const clearTimeout = vi.fn();
    const press = createLongPress(onFire, { timers: { setTimeout, clearTimeout } });
    press.down({ x: 0, y: 0 });
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), LONG_PRESS_MS);
    press.up();
    expect(clearTimeout).toHaveBeenCalledWith(42);
  });
});

describe('createRevealTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the first tap reveals and is spent; the next one acts and keeps the reveal going', () => {
    const onChange = vi.fn();
    const reveal = createRevealTimer(onChange);
    expect(reveal.revealed).toBe(false);
    expect(reveal.tap()).toBe(true);
    expect(reveal.revealed).toBe(true);
    expect(onChange).toHaveBeenCalledWith(true);
    vi.advanceTimersByTime(TOUCH_REVEAL_MS - 500);
    expect(reveal.tap()).toBe(false);
    vi.advanceTimersByTime(TOUCH_REVEAL_MS - 500);
    // Still on: the second tap restarted the clock.
    expect(reveal.revealed).toBe(true);
    vi.advanceTimersByTime(500);
    expect(reveal.revealed).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('hides by itself after the duration', () => {
    const onChange = vi.fn();
    const reveal = createRevealTimer(onChange, 1000);
    reveal.show();
    vi.advanceTimersByTime(999);
    expect(reveal.revealed).toBe(true);
    vi.advanceTimersByTime(1);
    expect(reveal.revealed).toBe(false);
  });

  it('hide stops the clock and reports only real changes', () => {
    const onChange = vi.fn();
    const reveal = createRevealTimer(onChange, 1000);
    reveal.hide();
    expect(onChange).not.toHaveBeenCalled();
    reveal.show();
    reveal.hide();
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe('gridColumns / fitColumn', () => {
  it('is one column only on a phone held upright', () => {
    expect(gridColumns(true, true)).toBe(1);
    expect(gridColumns(true, false)).toBe(2);
    expect(gridColumns(false, true)).toBe(2);
    expect(gridColumns(false, false)).toBe(2);
  });

  it('fills the width with a 16:9 tile in whole pixels, never negative', () => {
    expect(fitColumn(374)).toEqual({ tileWidth: 374, tileHeight: 210 });
    expect(fitColumn(320.6)).toEqual({ tileWidth: 320, tileHeight: 180 });
    expect(fitColumn(0)).toEqual({ tileWidth: 0, tileHeight: 0 });
    expect(fitColumn(-5)).toEqual({ tileWidth: 0, tileHeight: 0 });
  });
});

describe('usesVideoFullscreen', () => {
  const video = { webkitEnterFullscreen: () => undefined };

  it('prefers the page when it can go fullscreen', () => {
    expect(usesVideoFullscreen({ fullscreenEnabled: true }, video)).toBe(false);
  });

  it('falls back to the video on a page without fullscreen (iPhone)', () => {
    expect(usesVideoFullscreen({ fullscreenEnabled: false }, video)).toBe(true);
    expect(usesVideoFullscreen({}, video)).toBe(true);
  });

  it('has nothing to fall back to without the video or its method', () => {
    expect(usesVideoFullscreen({ fullscreenEnabled: false }, null)).toBe(false);
    expect(usesVideoFullscreen({ fullscreenEnabled: false }, {})).toBe(false);
    expect(usesVideoFullscreen({}, { webkitEnterFullscreen: true })).toBe(false);
  });
});
