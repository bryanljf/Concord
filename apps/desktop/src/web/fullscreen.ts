/**
 * The Fullscreen API behind a small interface, so `api.ts` can be tested without a DOM. On
 * iPhone Safari the page itself cannot go fullscreen (`requestFullscreen` is missing or rejects):
 * the tiles then use the video element's own control instead (renderer).
 */
export interface FullscreenHost {
  request(): Promise<void>;
  exit(): Promise<void>;
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
}

export function browserFullscreen(doc: Document): FullscreenHost {
  const root = doc.documentElement;
  // `fullscreenElement` is undefined (not null) where the API does not exist.
  const isActive = (): boolean => Boolean(doc.fullscreenElement);
  return {
    request: () =>
      typeof root.requestFullscreen === 'function' ? root.requestFullscreen() : Promise.resolve(),
    exit: () =>
      isActive() && typeof doc.exitFullscreen === 'function'
        ? doc.exitFullscreen()
        : Promise.resolve(),
    isActive,
    subscribe(listener) {
      const handler = (): void => listener(isActive());
      doc.addEventListener('fullscreenchange', handler);
      return () => {
        doc.removeEventListener('fullscreenchange', handler);
      };
    },
  };
}
