import type { CaptureCrop } from '../../preload/api';

/** A rectangle inside a video frame, in pixels of that frame. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Aspect-ratio drift (relative) beyond which a crop is considered to belong to another frame size. */
const ASPECT_TOLERANCE = 0.02;

/** H.264 4:2:0 wants even coordinates and sizes. */
function nearestEven(value: number): number {
  return Math.round(value / 2) * 2;
}

function floorEven(value: number): number {
  return value - (value % 2);
}

/**
 * The crop rectangle in the pixels of the frame that was actually delivered. The capture
 * constraints may downscale the window image, so the crop (in pixels of the full window image) is
 * scaled by `coded / frame` per axis, rounded to even numbers and clamped inside the frame.
 *
 * Null when the frame must go through untouched: no usable crop, a crop that was measured for a
 * differently shaped frame (the window was resized and the answer is still on its way), or a
 * crop that removes nothing after scaling.
 */
export function scaleCrop(
  crop: CaptureCrop | null,
  codedWidth: number,
  codedHeight: number,
): PixelRect | null {
  if (!crop) return null;
  if (!(codedWidth >= 2 && codedHeight >= 2 && crop.frameWidth > 0 && crop.frameHeight > 0)) {
    return null;
  }
  const cropAspect = crop.frameWidth / crop.frameHeight;
  const frameAspect = codedWidth / codedHeight;
  if (Math.abs(cropAspect - frameAspect) / cropAspect > ASPECT_TOLERANCE) return null;

  const scaleX = codedWidth / crop.frameWidth;
  const scaleY = codedHeight / crop.frameHeight;
  const maxWidth = floorEven(codedWidth);
  const maxHeight = floorEven(codedHeight);
  const left = Math.min(Math.max(nearestEven(crop.x * scaleX), 0), maxWidth);
  const top = Math.min(Math.max(nearestEven(crop.y * scaleY), 0), maxHeight);
  const right = Math.min(Math.max(nearestEven((crop.x + crop.width) * scaleX), 0), maxWidth);
  const bottom = Math.min(Math.max(nearestEven((crop.y + crop.height) * scaleY), 0), maxHeight);
  const width = right - left;
  const height = bottom - top;
  if (width < 2 || height < 2) return null;
  if (width >= maxWidth && height >= maxHeight) return null;
  return { x: left, y: top, width, height };
}

/**
 * Rate limiter for crop requests: runs `ask` right away, at most once per `intervalMs`; requests
 * in between collapse into one trailing call. `now` and the timers are injectable for tests.
 */
export function createThrottledAsk(
  ask: () => void,
  intervalMs: number,
  clock: {
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  } = {
    now: () => Date.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): { request(): void; cancel(): void } {
  let last = Number.NEGATIVE_INFINITY;
  let pending: unknown = null;
  const run = (): void => {
    pending = null;
    last = clock.now();
    ask();
  };
  return {
    request() {
      if (pending !== null) return;
      const wait = last + intervalMs - clock.now();
      if (wait <= 0) run();
      else pending = clock.setTimeout(run, wait);
    },
    cancel() {
      if (pending !== null) clock.clearTimeout(pending);
      pending = null;
    },
  };
}
