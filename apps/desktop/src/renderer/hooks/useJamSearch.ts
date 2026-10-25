import { useEffect, useState } from 'react';
import type { JamTrack } from '@concord/shared';
import { concord, toErrorMessage } from '../lib/concord';
import { JAM_SEARCH_DEBOUNCE_MS } from '../lib/jam';

export type JamSearchState =
  | { status: 'idle' }
  /** Waiting for the typing to pause or for the server; the previous results stay on screen. */
  | { status: 'searching'; results: readonly JamTrack[] }
  | { status: 'done'; query: string; results: readonly JamTrack[] }
  | { status: 'error'; message: string };

interface Answer {
  query: string;
  results: readonly JamTrack[];
  error: string | null;
}

const NO_RESULTS: readonly JamTrack[] = [];

/**
 * YouTube Music results for `query` (null: nothing to search), asked once the typing pauses
 * (`JAM_SEARCH_DEBOUNCE_MS`); an answer for a query that is no longer in the box is ignored.
 */
export function useJamSearch(query: string | null): JamSearchState {
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (query === null) return;
    let active = true;
    const timer = window.setTimeout(() => {
      Promise.resolve()
        .then(() => concord().searchJam(query))
        .then(
          (results) => {
            if (active) setAnswer({ query, results, error: null });
          },
          (err: unknown) => {
            if (!active) return;
            const error = toErrorMessage(err, 'Não foi possível buscar agora. Tente de novo.');
            setAnswer({ query, results: NO_RESULTS, error });
          },
        );
    }, JAM_SEARCH_DEBOUNCE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  if (query === null) return { status: 'idle' };
  if (answer?.query !== query) {
    return { status: 'searching', results: answer?.results ?? NO_RESULTS };
  }
  if (answer.error !== null) return { status: 'error', message: answer.error };
  return { status: 'done', query, results: answer.results };
}
