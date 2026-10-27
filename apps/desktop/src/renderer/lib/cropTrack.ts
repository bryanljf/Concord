import type { CaptureCrop } from '../../preload/api';
import { createThrottledAsk, scaleCrop } from './cropMath';
import {
  createCropTransform,
  type CropSizes,
  type CropWorkerRequest,
  type CropWorkerResponse,
} from './cropPipeline';

/** Chrome's insertable-streams API; not in lib.dom, so typed here and read off `globalThis`. */
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
interface InsertableStreams {
  MediaStreamTrackProcessor?: new (init: {
    track: MediaStreamTrack;
    maxBufferSize?: number;
  }) => TrackProcessor;
  MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => TrackGenerator;
}

/** Re-ask main at most this often when the delivered frame size changes. */
export const CROP_REFRESH_MS = 500;
/** How long the worker has to say it is alive before the main-thread pipeline takes over. */
const WORKER_START_TIMEOUT_MS = 1500;
/** Longest wait for the first crop answer before frames start flowing uncropped. */
const FIRST_CROP_TIMEOUT_MS = 1000;

export interface CropTrackOptions {
  /** Asks main where the app content sits in the captured window (null: nothing to crop). */
  getCrop(): Promise<CaptureCrop | null>;
  /** Reports a pipeline problem; the returned track keeps working (frames go uncropped). */
  onError?(message: string, err?: unknown): void;
}

export interface CroppedTrack {
  /** Same capture, minus the window chrome. `stop()` also stops the original track. */
  track: MediaStreamTrack;
  /** Latest output size in pixels (what is encoded), null before the first frame. */
  size(): { width: number; height: number } | null;
}

export function isCropSupported(): boolean {
  const api = globalThis as unknown as InsertableStreams;
  return (
    typeof api.MediaStreamTrackProcessor === 'function' &&
    typeof api.MediaStreamTrackGenerator === 'function' &&
    typeof VideoFrame === 'function'
  );
}

/** Resolves with a worker that answered `ready`, or null (no worker support, load error, timeout). */
function startWorker(): Promise<Worker | null> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./cropWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      resolve(null);
      return;
    }
    const fail = (): void => {
      clearTimeout(timer);
      worker.terminate();
      resolve(null);
    };
    const timer = setTimeout(fail, WORKER_START_TIMEOUT_MS);
    worker.addEventListener('error', fail, { once: true });
    worker.addEventListener(
      'message',
      (event: MessageEvent<CropWorkerResponse>) => {
        if (event.data.type !== 'ready') {
          fail();
          return;
        }
        clearTimeout(timer);
        worker.removeEventListener('error', fail);
        resolve(worker);
      },
      { once: true },
    );
  });
}

/**
 * Wraps a captured window video track so only its client area is published.
 *
 * Frames flow `MediaStreamTrackProcessor` -> crop (`new VideoFrame(frame, { visibleRect })`) ->
 * `MediaStreamTrackGenerator`. The readable/writable streams are transferred to a dedicated worker
 * so the UI thread never touches pixels; when the worker cannot start, the same transform runs on
 * the main thread. Throws when the browser lacks the API (callers fall back to the original).
 */
export async function createCroppedTrack(
  source: MediaStreamTrack,
  options: CropTrackOptions,
): Promise<CroppedTrack> {
  const api = globalThis as unknown as InsertableStreams;
  if (!api.MediaStreamTrackProcessor || !api.MediaStreamTrackGenerator) {
    throw new Error('Insertable streams are not available');
  }
  const processor = new api.MediaStreamTrackProcessor({ track: source, maxBufferSize: 3 });
  const generator = new api.MediaStreamTrackGenerator({ kind: 'video' });
  generator.contentHint = source.contentHint;

  let crop: CaptureCrop | null = null;
  let output: { width: number; height: number } | null = null;
  let stopped = false;
  let worker: Worker | null = null;

  const setCrop = (next: CaptureCrop | null): void => {
    crop = next;
    const message: CropWorkerRequest = { type: 'crop', crop: next };
    worker?.postMessage(message);
  };
  const ask = createThrottledAsk(() => {
    options
      .getCrop()
      .then((next) => {
        if (!stopped) setCrop(next);
      })
      .catch((err: unknown) => options.onError?.('crop lookup failed', err));
  }, CROP_REFRESH_MS);

  let inputSize = '';
  const onSizes = (sizes: CropSizes): void => {
    output = { width: sizes.outputWidth, height: sizes.outputHeight };
    const key = `${sizes.inputWidth}x${sizes.inputHeight}`;
    if (key !== inputSize) {
      inputSize = key;
      ask.request();
    }
  };

  // The first answer is awaited (briefly) so the very first frames, and the size livekit reads
  // when it publishes, are already cropped.
  crop = await Promise.race([
    options.getCrop().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), FIRST_CROP_TIMEOUT_MS)),
  ]);
  const settings = source.getSettings();
  const expected =
    settings.width && settings.height ? scaleCrop(crop, settings.width, settings.height) : null;
  if (expected) output = { width: expected.width, height: expected.height };

  worker = await startWorker();
  if (worker) {
    worker.addEventListener('message', (event: MessageEvent<CropWorkerResponse>) => {
      if (event.data.type === 'sizes') onSizes(event.data.sizes);
      else if (event.data.type === 'error') {
        options.onError?.('crop worker failed', event.data.message);
      }
    });
    const init: CropWorkerRequest = {
      type: 'init',
      readable: processor.readable,
      writable: generator.writable,
    };
    worker.postMessage(init, [processor.readable, generator.writable]);
    setCrop(crop);
  } else {
    processor.readable
      .pipeThrough(createCropTransform({ getCrop: () => crop, onSizes }))
      .pipeTo(generator.writable)
      .catch((err: unknown) => {
        if (!stopped) options.onError?.('crop pipeline failed', err);
      });
  }
  const originalStop = generator.stop.bind(generator);
  const teardown = (): void => {
    if (stopped) return;
    stopped = true;
    ask.cancel();
    worker?.terminate();
    worker = null;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    originalStop();
  };
  generator.stop = teardown;
  source.addEventListener(
    'ended',
    () => {
      if (stopped) return;
      teardown();
      generator.dispatchEvent(new Event('ended'));
    },
    { once: true },
  );

  // The generator does not always report the frame size; the cropped size is known here.
  const generatorSettings = generator.getSettings.bind(generator);
  generator.getSettings = () => {
    const settings = { ...source.getSettings(), ...generatorSettings() };
    return output ? { ...settings, width: output.width, height: output.height } : settings;
  };

  return { track: generator, size: () => output };
}
