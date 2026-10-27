import { describe, expect, it } from 'vitest';
import {
  computeCaptureCrop,
  getWindowCaptureCrop,
  type Rect,
  type WindowCropNative,
} from './window-crop';

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({
  left,
  top,
  right,
  bottom,
});

describe('computeCaptureCrop', () => {
  it('crops a title bar (1280x720 client in a 1280x752 frame)', () => {
    expect(computeCaptureCrop(rect(100, 100, 1380, 852), rect(100, 132, 1380, 852))).toEqual({
      frameWidth: 1280,
      frameHeight: 752,
      x: 0,
      y: 32,
      width: 1280,
      height: 720,
    });
  });

  it('is relative to the frame and handles side borders', () => {
    expect(computeCaptureCrop(rect(-50, 10, 950, 610), rect(-42, 40, 942, 602))).toEqual({
      frameWidth: 1000,
      frameHeight: 600,
      x: 8,
      y: 30,
      width: 984,
      height: 562,
    });
  });

  it('clamps a client rect that spills outside the frame', () => {
    expect(computeCaptureCrop(rect(0, 0, 800, 600), rect(-10, 30, 900, 700))).toEqual({
      frameWidth: 800,
      frameHeight: 600,
      x: 0,
      y: 30,
      width: 800,
      height: 570,
    });
  });

  it('returns null when nothing is removed (within 1 px)', () => {
    expect(computeCaptureCrop(rect(0, 0, 1920, 1080), rect(0, 0, 1920, 1080))).toBeNull();
    expect(computeCaptureCrop(rect(0, 0, 1920, 1080), rect(1, 0, 1920, 1079))).toBeNull();
  });

  it('returns null for empty or disjoint rectangles', () => {
    expect(computeCaptureCrop(rect(0, 0, 0, 0), rect(0, 0, 10, 10))).toBeNull();
    expect(computeCaptureCrop(rect(0, 0, 100, 100), rect(10, 10, 10, 50))).toBeNull();
    expect(computeCaptureCrop(rect(0, 0, 100, 100), rect(200, 200, 300, 300))).toBeNull();
  });
});

function fakeNative(overrides: Partial<WindowCropNative> = {}): WindowCropNative {
  return {
    isWindow: () => true,
    isIconic: () => false,
    frameBounds: () => rect(0, 0, 1280, 752),
    clientRect: () => rect(0, 32, 1280, 752),
    ...overrides,
  };
}

describe('getWindowCaptureCrop', () => {
  const run = (id: string, native: WindowCropNative | null, platform = 'win32') =>
    getWindowCaptureCrop(id, { platform, loadNative: () => native });

  it('crops a live window', () => {
    expect(run('window:12345:0', fakeNative())?.y).toBe(32);
  });

  it('ignores screens, malformed ids and other platforms', () => {
    expect(run('screen:0:0', fakeNative())).toBeNull();
    expect(run('window:abc:0', fakeNative())).toBeNull();
    expect(run('window:12345:0', fakeNative(), 'linux')).toBeNull();
  });

  it('returns null for gone or minimized windows and a missing native binding', () => {
    expect(run('window:12345:0', fakeNative({ isWindow: () => false }))).toBeNull();
    expect(run('window:12345:0', fakeNative({ isIconic: () => true }))).toBeNull();
    expect(run('window:12345:0', null)).toBeNull();
  });

  it('never throws', () => {
    const boom = fakeNative({
      frameBounds: () => {
        throw new Error('x');
      },
    });
    expect(run('window:12345:0', boom)).toBeNull();
  });
});
