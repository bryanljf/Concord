import { useCallback, useRef, useState } from 'react';
import type { RoomId } from '@concord/shared';
import { concord, toErrorMessage } from '../lib/concord';
import { useToast } from './useToast';

export interface JamActions {
  /** Requests still on their way: `pause`, `resume`, `skip:<itemId>`, `remove:<itemId>`. */
  busy: ReadonlySet<string>;
  /** Pauses / resumes the room's Jam for everyone. */
  pause(room: RoomId): void;
  resume(room: RoomId): void;
  /** Skips the song playing (only if it is still `itemId`). */
  skip(room: RoomId, itemId: string): void;
  /** Takes an upcoming song off the queue. */
  remove(room: RoomId, itemId: string): void;
}

const FAILURES = {
  pause: 'Não foi possível pausar a Jam.',
  resume: 'Não foi possível retomar a Jam.',
  skip: 'Não foi possível pular a música.',
  remove: 'Não foi possível tirar a música da fila.',
} as const;

/**
 * The Jam's controls, open to anyone in the room: each request disables its own button until the
 * server answers (the new state then arrives with the jam events); a refusal shows its pt-BR
 * message in a toast.
 */
export function useJamActions(): JamActions {
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // Read synchronously, so a double click never sends the same request twice.
  const inFlight = useRef(new Set<string>());

  const run = useCallback(
    (key: string, failure: string, request: () => Promise<void>) => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setBusy(new Set(inFlight.current));
      // A missing bridge throws synchronously: still a toast, never a stuck button.
      Promise.resolve()
        .then(request)
        .catch((err: unknown) => {
          toast.show(toErrorMessage(err, failure), { tone: 'error', durationMs: 6000 });
        })
        .finally(() => {
          inFlight.current.delete(key);
          setBusy(new Set(inFlight.current));
        });
    },
    [toast],
  );

  const pause = useCallback(
    (room: RoomId) => run('pause', FAILURES.pause, () => concord().pauseJam(room)),
    [run],
  );
  const resume = useCallback(
    (room: RoomId) => run('resume', FAILURES.resume, () => concord().resumeJam(room)),
    [run],
  );
  const skip = useCallback(
    (room: RoomId, itemId: string) =>
      run(`skip:${itemId}`, FAILURES.skip, () => concord().skipJam(room, itemId)),
    [run],
  );
  const remove = useCallback(
    (room: RoomId, itemId: string) =>
      run(`remove:${itemId}`, FAILURES.remove, () => concord().removeFromJam(room, itemId)),
    [run],
  );

  return { busy, pause, resume, skip, remove };
}
