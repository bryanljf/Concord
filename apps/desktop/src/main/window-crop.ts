import type { CaptureCrop } from '../preload/api';
import { parseCaptureSourceId } from './audio/source-id';
import { log } from './log';

/**
 * Where the app's own content sits inside a captured window, so the renderer can crop the title
 * bar and borders away before encoding.
 *
 * Windows Graphics Capture (what Chromium uses for `window:` sources) delivers the window's
 * visible frame: `DWMWA_EXTENDED_FRAME_BOUNDS`, which excludes the invisible resize borders and the
 * drop shadow that `GetWindowRect` includes. The client area comes from `GetClientRect` (size) and
 * `ClientToScreen` (origin). Everything is read in the same coordinate space: the Electron main
 * process is per-monitor-v2 DPI aware (Chromium's manifest), so DWM bounds, ClientToScreen and the
 * captured pixels are all physical pixels; no scaling is applied here.
 */

const logger = log('window-crop');

const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

/** A rectangle by edges, in screen pixels (Win32 `RECT`). */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What is left to crop within this many pixels counts as nothing (rounding between APIs). */
const TOLERANCE_PX = 1;

/**
 * The client rect (screen coordinates) relative to the frame (screen coordinates), clamped inside
 * it. Null when there is nothing to crop: the client area is empty, the frame is empty, or it
 * equals the frame within 1 px on every side.
 */
export function computeCaptureCrop(frame: Rect, client: Rect): CaptureCrop | null {
  const frameWidth = frame.right - frame.left;
  const frameHeight = frame.bottom - frame.top;
  if (!(frameWidth > 0 && frameHeight > 0)) return null;
  if (!(client.right > client.left && client.bottom > client.top)) return null;

  const left = Math.min(Math.max(client.left, frame.left), frame.right);
  const top = Math.min(Math.max(client.top, frame.top), frame.bottom);
  const right = Math.min(Math.max(client.right, frame.left), frame.right);
  const bottom = Math.min(Math.max(client.bottom, frame.top), frame.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;

  const x = left - frame.left;
  const y = top - frame.top;
  const removesNothing =
    x <= TOLERANCE_PX &&
    y <= TOLERANCE_PX &&
    frameWidth - (x + width) <= TOLERANCE_PX &&
    frameHeight - (y + height) <= TOLERANCE_PX;
  if (removesNothing) return null;
  return { frameWidth, frameHeight, x, y, width, height };
}

/** The Win32 reads, kept thin so the geometry above is testable without Windows. */
export interface WindowCropNative {
  isWindow(hwnd: number): boolean;
  isIconic(hwnd: number): boolean;
  frameBounds(hwnd: number): Rect | null;
  clientRect(hwnd: number): Rect | null;
}

export interface WindowCropDeps {
  platform: string;
  loadNative: () => WindowCropNative | null;
}

/** koffi is required lazily and guarded: without it (or off Windows) nothing is cropped. */
function loadNativeBinding(): WindowCropNative | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi');
    const user32 = koffi.load('user32.dll');
    const dwmapi = koffi.load('dwmapi.dll');
    const RECT = koffi.struct('CONCORD_CROP_RECT', {
      left: 'int32',
      top: 'int32',
      right: 'int32',
      bottom: 'int32',
    });
    koffi.struct('CONCORD_CROP_POINT', { x: 'int32', y: 'int32' });
    // HWND as a 64-bit integer: the number parsed from the source id is passed as is.
    const isWindow = user32.func('int32 IsWindow(intptr hwnd)');
    const isIconic = user32.func('int32 IsIconic(intptr hwnd)');
    const getClientRect = user32.func(
      'int32 GetClientRect(intptr hwnd, _Out_ CONCORD_CROP_RECT *rect)',
    );
    const clientToScreen = user32.func(
      'int32 ClientToScreen(intptr hwnd, _Inout_ CONCORD_CROP_POINT *point)',
    );
    const getAttribute = dwmapi.func(
      'int32 DwmGetWindowAttribute(intptr hwnd, uint32 attribute, _Out_ CONCORD_CROP_RECT *value, uint32 size)',
    );
    const rectSize = koffi.sizeof(RECT);
    return {
      isWindow: (hwnd) => isWindow(hwnd) !== 0,
      isIconic: (hwnd) => isIconic(hwnd) !== 0,
      frameBounds: (hwnd) => {
        const out: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
        // HRESULT: 0 = S_OK.
        return getAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, out, rectSize) === 0 ? out : null;
      },
      clientRect: (hwnd) => {
        const size: Rect = { left: 0, top: 0, right: 0, bottom: 0 };
        if (getClientRect(hwnd, size) === 0) return null;
        const origin = { x: 0, y: 0 };
        if (clientToScreen(hwnd, origin) === 0) return null;
        return {
          left: origin.x,
          top: origin.y,
          right: origin.x + (size.right - size.left),
          bottom: origin.y + (size.bottom - size.top),
        };
      },
    };
  } catch (err) {
    logger.warn('koffi could not be loaded', err);
    return null;
  }
}

let cached: WindowCropNative | null | undefined;
function cachedNative(): WindowCropNative | null {
  if (cached === undefined) cached = loadNativeBinding();
  return cached;
}

/**
 * The crop for a `window:<hwnd>:<n>` source id; null for anything else (screens, malformed ids),
 * windows that are gone or minimized, and windows with nothing to crop. Never throws.
 */
export function getWindowCaptureCrop(
  sourceId: string,
  overrides: Partial<WindowCropDeps> = {},
): CaptureCrop | null {
  const deps: WindowCropDeps = {
    platform: process.platform,
    loadNative: cachedNative,
    ...overrides,
  };
  if (deps.platform !== 'win32') return null;
  const ref = parseCaptureSourceId(sourceId);
  if (ref?.kind !== 'window') return null;
  const native = deps.loadNative();
  if (!native) return null;
  try {
    if (!native.isWindow(ref.handle) || native.isIconic(ref.handle)) return null;
    const frame = native.frameBounds(ref.handle);
    const client = native.clientRect(ref.handle);
    if (!frame || !client) return null;
    return computeCaptureCrop(frame, client);
  } catch (err) {
    logger.warn('could not read the window geometry', err);
    return null;
  }
}
