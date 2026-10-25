/**
 * The browser globals the web bridge touches, behind one object so `createWebApi` can be built
 * in tests (Node, no DOM) with fakes. `browserEnv()` is the real thing.
 */
import { browserFullscreen, type FullscreenHost } from './fullscreen';
import type { EventSourceLike, VisibilitySource } from './presence';
import type { StorageLike } from './settings';

export interface WebLocation {
  readonly origin: string;
  readonly host: string;
  readonly href: string;
  assign(url: string): void;
}

export interface WebHistory {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

export interface WebEnv {
  fetchImpl: typeof fetch;
  location: WebLocation;
  history: WebHistory | null;
  /** `localStorage` on every access (touching it may throw); null when there is none. */
  storage(): StorageLike | null;
  createEventSource(url: string): EventSourceLike;
  /** `document`, for `visibilitychange`; null when the page cannot tell. */
  visibility: VisibilitySource | null;
  fullscreen: FullscreenHost | null;
  openWindow(url: string): void;
  /** `navigator.platform` ("iPhone", "Linux armv8l", "Win32"…): only shortcut labels read it. */
  platform: string;
}

export function browserEnv(): WebEnv {
  return {
    fetchImpl: (input, init) => fetch(input, init),
    location: window.location,
    history: window.history,
    storage: () => window.localStorage,
    createEventSource: (url) => new EventSource(url),
    visibility: document,
    fullscreen: browserFullscreen(document),
    openWindow: (url) => {
      window.open(url, '_blank', 'noopener');
    },
    platform: navigator.platform,
  };
}
