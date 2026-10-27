import type { CaptureCrop } from '../../preload/api';
import { scaleCrop } from './cropMath';

/** Frame sizes seen by the transform, reported when either changes. */
export interface CropSizes {
  inputWidth: number;
  inputHeight: number;
  outputWidth: number;
  outputHeight: number;
}

export interface CropTransformOptions {
  /** The latest crop answer (read per frame), null while unknown or when there is nothing to crop. */
  getCrop(): CaptureCrop | null;
  /** Called when the input or the output frame size changes (and for the first frame). */
  onSizes(sizes: CropSizes): void;
}

/**
 * The per-frame work, shared by the worker and the main-thread fallback. Every input frame is
 * closed (or handed on, uncropped); every output frame is owned by the stream after `enqueue`.
 * A failure on one frame passes that frame through uncropped: the live must keep flowing.
 */
export function createCropTransform(
  options: CropTransformOptions,
): TransformStream<VideoFrame, VideoFrame> {
  let last: CropSizes | null = null;
  return new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, controller) {
      const inputWidth = frame.codedWidth;
      const inputHeight = frame.codedHeight;
      let output = frame;
      try {
        const rect = scaleCrop(options.getCrop(), inputWidth, inputHeight);
        if (rect) {
          output = new VideoFrame(frame, {
            visibleRect: rect,
            displayWidth: rect.width,
            displayHeight: rect.height,
          });
          frame.close();
        }
      } catch {
        output = frame;
      }
      const sizes: CropSizes = {
        inputWidth,
        inputHeight,
        outputWidth: output.displayWidth,
        outputHeight: output.displayHeight,
      };
      if (
        !last ||
        last.inputWidth !== sizes.inputWidth ||
        last.inputHeight !== sizes.inputHeight ||
        last.outputWidth !== sizes.outputWidth ||
        last.outputHeight !== sizes.outputHeight
      ) {
        last = sizes;
        options.onSizes(sizes);
      }
      controller.enqueue(output);
    },
  });
}

/** Messages between the crop worker and the renderer. */
export type CropWorkerRequest =
  | { type: 'init'; readable: ReadableStream<VideoFrame>; writable: WritableStream<VideoFrame> }
  | { type: 'crop'; crop: CaptureCrop | null };

export type CropWorkerResponse =
  { type: 'ready' } | { type: 'sizes'; sizes: CropSizes } | { type: 'error'; message: string };
