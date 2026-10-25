import { useSyncExternalStore } from 'react';
import { PHONE_QUERY, PORTRAIT_QUERY, TOUCH_QUERY } from '../lib/touch';

export interface Viewport {
  /** A phone-sized window (`PHONE_QUERY`): drawer sidebar, one-column grid, bottom sheets. */
  phone: boolean;
  /** A touch screen (`TOUCH_QUERY`): hover-only controls are revealed by a tap. */
  touch: boolean;
  /** Taller than wide (`PORTRAIT_QUERY`). */
  portrait: boolean;
}

/** Without `matchMedia` (unit tests, the server snapshot) everything is the desktop. */
const DESKTOP: Viewport = { phone: false, touch: false, portrait: false };

const QUERIES = [PHONE_QUERY, TOUCH_QUERY, PORTRAIT_QUERY] as const;

function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

function matches(query: string): boolean {
  return window.matchMedia(query).matches;
}

// One snapshot for every subscriber: `useSyncExternalStore` needs the same object back while
// nothing changed.
let snapshot: Viewport = DESKTOP;

function getSnapshot(): Viewport {
  if (!canMatch()) return DESKTOP;
  const next: Viewport = {
    phone: matches(PHONE_QUERY),
    touch: matches(TOUCH_QUERY),
    portrait: matches(PORTRAIT_QUERY),
  };
  if (
    next.phone !== snapshot.phone ||
    next.touch !== snapshot.touch ||
    next.portrait !== snapshot.portrait
  ) {
    snapshot = next;
  }
  return snapshot;
}

function getServerSnapshot(): Viewport {
  return DESKTOP;
}

function subscribe(onChange: () => void): () => void {
  if (!canMatch()) return () => undefined;
  const lists = QUERIES.map((query) => window.matchMedia(query));
  for (const list of lists) list.addEventListener('change', onChange);
  return () => {
    for (const list of lists) list.removeEventListener('change', onChange);
  };
}

/**
 * Whether this is a phone-sized window, a touch screen and which way it is held, kept up to date
 * as the window resizes or the phone rotates (`matchMedia` change events).
 */
export function useViewport(): Viewport {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
