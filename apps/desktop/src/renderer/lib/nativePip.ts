/**
 * The browser's own picture-in-picture for one stream (web client: `capabilities.nativeVideoPip`),
 * instead of the desktop's pop-out and PiP windows. Every stream tile carries
 * `data-stream-key="<key>"` on its root; the `<video>` inside it is handed to
 * `requestPictureInPicture()` (Chromium, Firefox) or, on Safari, to
 * `webkitSetPresentationMode('picture-in-picture')`. The selection and the method choice are pure
 * (unit-tested); `requestNativePip` touches the DOM.
 */

/** How a `<video>` can go picture-in-picture, by what it exposes. */
export type NativePipMethod = 'standard' | 'webkit';

/** The subset of HTMLVideoElement the method choice looks at (plain objects in tests). */
export interface PipCapableVideo {
  requestPictureInPicture?: unknown;
  webkitSetPresentationMode?: unknown;
  webkitSupportsPresentationMode?: unknown;
  disablePictureInPicture?: boolean;
}

export interface PipDocument {
  pictureInPictureEnabled?: boolean;
}

export const NATIVE_PIP_UNAVAILABLE = 'O picture-in-picture não está disponível neste navegador.';
export const NATIVE_PIP_NO_VIDEO = 'O vídeo ainda não está sendo reproduzido aqui.';

/** Escapes a stream key for use inside a double-quoted CSS attribute selector. */
export function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** The selector of the `<video>` playing the stream `key`. */
export function streamVideoSelector(key: string): string {
  return `[data-stream-key="${escapeAttributeValue(key)}"] video`;
}

/**
 * Which picture-in-picture call a video accepts: the standard API when the document allows it
 * (and the video does not opt out), else Safari's presentation mode when it says it supports it,
 * else null.
 */
export function nativePipMethod(video: PipCapableVideo, doc: PipDocument): NativePipMethod | null {
  if (
    doc.pictureInPictureEnabled === true &&
    !video.disablePictureInPicture &&
    typeof video.requestPictureInPicture === 'function'
  ) {
    return 'standard';
  }
  if (
    typeof video.webkitSetPresentationMode === 'function' &&
    typeof video.webkitSupportsPresentationMode === 'function' &&
    video.webkitSupportsPresentationMode.call(video, 'picture-in-picture') === true
  ) {
    return 'webkit';
  }
  return null;
}

/** Whether the standard API exists here at all (Safari may still have the webkit one). */
export function nativePipAvailable(doc: PipDocument = document): boolean {
  return doc.pictureInPictureEnabled === true;
}

interface SafariVideo extends HTMLVideoElement {
  webkitSetPresentationMode?(mode: 'picture-in-picture' | 'inline' | 'fullscreen'): void;
  webkitPresentationMode?: string;
}

/**
 * Puts the stream `key` in the browser's picture-in-picture (or takes it out when it already is
 * there). Must be called from a user gesture. Rejects with a pt-BR message when the tile has no
 * playing video or the browser offers neither API.
 */
export async function requestNativePip(key: string, root: ParentNode = document): Promise<void> {
  const video = root.querySelector<HTMLVideoElement>(streamVideoSelector(key));
  if (!video) throw new Error(NATIVE_PIP_NO_VIDEO);
  const method = nativePipMethod(video, document);
  if (method === 'standard') {
    if (document.pictureInPictureElement === video) {
      await document.exitPictureInPicture();
      return;
    }
    await video.requestPictureInPicture();
    return;
  }
  if (method === 'webkit') {
    const safari = video as SafariVideo;
    const inPip = safari.webkitPresentationMode === 'picture-in-picture';
    safari.webkitSetPresentationMode?.(inPip ? 'inline' : 'picture-in-picture');
    return;
  }
  throw new Error(NATIVE_PIP_UNAVAILABLE);
}
