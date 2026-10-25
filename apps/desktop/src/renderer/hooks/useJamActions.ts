import { useCallback, useMemo, useRef, useState } from 'react';
import type { RoomId } from '@concord/shared';
import { concord, toErrorMessage } from '../lib/concord';
import { createJamSeekSender, type JamSeekOutcome } from '../lib/jamSeek';
import { useToast } from './useToast';

export interface JamActions {
  /**
   * Requests still on their way: `pause`, `resume`, `previous`, `skip:<itemId>`,
   * `remove:<itemId>` (seeks never disable anything: the latest one wins).
   */
  busy: ReadonlySet<string>;
  /** Pauses / resumes the room's Jam for everyone. */
  pause(room: RoomId): void;
  resume(room: RoomId): void;
  /** "Música anterior": the previous song from the start (`itemId`: the one playing, if any). */
  previous(room: RoomId, itemId: string | null): void;
  /** Skips the song playing (only if it is still `itemId`). */
  skip(room: RoomId, itemId: string): void;
  /**
   * Moves the song playing (only if it is still `itemId`) to `positionMs` (whole milliseconds),
   * for everyone. One request at a time, the latest winning; resolves with how it went.
   */
  seek(room: RoomId, itemId: string, positionMs: number): Promise<JamSeekOutcome>;
  /** Takes an upcoming song off the queue. */
  remove(room: RoomId, itemId: string): void;
}

const FAILURES = {
  pause: 'Não foi possível pausar a Jam.',
  resume: 'Não foi possível retomar a Jam.',
  previous: 'Não foi possível voltar para a música anterior.',
  skip: 'Não foi possível pular a música.',
  seek: 'Não foi possível mudar a posição da música.',
  remove: 'Não foi possível tirar a música da fila.',
} as const;

interface SeekRequest {
  room: RoomId;
  itemId: string;
  positionMs: number;
}

/**
 * The Jam's controls, open to anyone in the room: each request disables its own button until the
 * server answers (the new state then arrives with the jam events); a refusal shows its pt-BR
 * message in a toast. Seeks go out one at a time, a newer one replacing any still waiting.
 */
export function useJamActions(): JamActions {
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  // Read synchronously, so a double click never sends the same request twice.
  const inFlight = useRef(new Set<string>());

  const showFailure = useCallback(
    (err: unknown, failure: string) => {
      toast.show(toErrorMessage(err, failure), { tone: 'error', durationMs: 6000 });
    },
    [toast],
  );

  const run = useCallback(
    (key: string, failure: string, request: () => Promise<void>) => {
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      setBusy(new Set(inFlight.current));
      // A missing bridge throws synchronously: still a toast, never a stuck button.
      Promise.resolve()
        .then(request)
        .catch((err: unknown) => showFailure(err, failure))
        .finally(() => {
          inFlight.current.delete(key);
          setBusy(new Set(inFlight.current));
        });
    },
    [showFailure],
  );

  const seeker = useMemo(
    () =>
      createJamSeekSender<SeekRequest>(
        ({ room, itemId, positionMs }) =>
          // IPC takes whole milliseconds only.
          concord().seekJam(room, itemId, Math.max(0, Math.round(positionMs))),
        (err) => showFailure(err, FAILURES.seek),
      ),
    [showFailure],
  );

  const pause = useCallback(
    (room: RoomId) => run('pause', FAILURES.pause, () => concord().pauseJam(room)),
    [run],
  );
  const resume = useCallback(
    (room: RoomId) => run('resume', FAILURES.resume, () => concord().resumeJam(room)),
    [run],
  );
  const previous = useCallback(
    (room: RoomId, itemId: string | null) =>
      run('previous', FAILURES.previous, () => concord().previousJam(room, itemId)),
    [run],
  );
  const skip = useCallback(
    (room: RoomId, itemId: string) =>
      run(`skip:${itemId}`, FAILURES.skip, () => concord().skipJam(room, itemId)),
    [run],
  );
  const seek = useCallback(
    (room: RoomId, itemId: string, positionMs: number) => seeker.send({ room, itemId, positionMs }),
    [seeker],
  );
  const remove = useCallback(
    (room: RoomId, itemId: string) =>
      run(`remove:${itemId}`, FAILURES.remove, () => concord().removeFromJam(room, itemId)),
    [run],
  );

  return { busy, pause, resume, previous, skip, seek, remove };
}
