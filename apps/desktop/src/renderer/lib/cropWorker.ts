import type { CaptureCrop } from '../../preload/api';
import {
  createCropTransform,
  type CropWorkerRequest,
  type CropWorkerResponse,
} from './cropPipeline';

/**
 * Dedicated worker: crops the frames of a transferred `MediaStreamTrackProcessor` readable and
 * writes them to a transferred `MediaStreamTrackGenerator` writable, off the UI thread.
 */
interface WorkerScope {
  postMessage(message: CropWorkerResponse): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<CropWorkerRequest>) => void,
  ): void;
}

const scope = self as unknown as WorkerScope;
let crop: CaptureCrop | null = null;

scope.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'crop') {
    crop = message.crop;
    return;
  }
  const transform = createCropTransform({
    getCrop: () => crop,
    onSizes: (sizes) => scope.postMessage({ type: 'sizes', sizes }),
  });
  message.readable
    .pipeThrough(transform)
    .pipeTo(message.writable)
    .catch((err: unknown) => {
      scope.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
});

scope.postMessage({ type: 'ready' });
