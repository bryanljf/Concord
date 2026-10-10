import { useSyncExternalStore } from 'react';

const TICK_MS = 30_000;

function subscribe(onChange: () => void): () => void {
  const id = window.setInterval(onChange, TICK_MS);
  return () => window.clearInterval(id);
}

/** Quantized so the snapshot is stable between ticks (required by useSyncExternalStore). */
function getSnapshot(): number {
  return Math.floor(Date.now() / TICK_MS) * TICK_MS;
}

/** Current time (ms), refreshed every 30 s — for "entrou há 3 min" style labels. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
