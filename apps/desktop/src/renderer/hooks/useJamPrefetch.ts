import { useEffect, useState } from 'react';
import { concord } from '../lib/concord';
import { createJamPrefetcher, type JamPrefetcher } from '../lib/jam';

/** Fire and forget: a refusal (or a failure in main) only means no head start for that song. */
function prefetch(videoId: string): void {
  Promise.resolve()
    .then(() => concord().prefetchJam([videoId]))
    .catch(() => undefined);
}

/**
 * The search dialog's head start (`lib/jam.ts` `createJamPrefetcher`): a result hovered or
 * focused for a moment, or a YouTube link pasted, starts downloading in main before it is picked.
 * One per dialog: each song is asked for at most once while it stays open.
 */
export function useJamPrefetch(): JamPrefetcher {
  const [prefetcher] = useState(() => createJamPrefetcher(prefetch));
  useEffect(() => () => prefetcher.clear(), [prefetcher]);
  return prefetcher;
}
