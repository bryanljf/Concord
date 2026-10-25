/**
 * The yt-dlp processes the Jam may run at once (each one is Python plus the Node it solves
 * YouTube's challenges with): upload jobs, prefetches and the warm-up share
 * `JAM_MAX_YTDLP_PROCESSES` slots. Jobs are served first, in order; prefetches after them, the
 * most recent first. A job that finds every slot taken stops a prefetch (`onPreempt`) to get one.
 * A slot is released when its process is gone, so the limit counts real processes.
 * Electron-free.
 */

export const JAM_MAX_YTDLP_PROCESSES = 2;

/** `job`: a song someone added; `prefetch`: a download that may never be needed (or the warm-up). */
export type YtDlpSlotKind = 'job' | 'prefetch';

export interface YtDlpSlot {
  /** A prefetch's song was added: from now on its slot is a job's, never preempted. */
  promote(): void;
  /** Its process is gone (idempotent). */
  release(): void;
}

export interface YtDlpSlots {
  /**
   * Resolves once a process may start; rejects with the abort reason if `signal` aborts first.
   * `onPreempt` (prefetches): called once when a job needs the slot; the holder must then stop
   * its process, and release the slot once it is gone.
   */
  acquire(kind: YtDlpSlotKind, signal?: AbortSignal, onPreempt?: () => void): Promise<YtDlpSlot>;
  /** Slots held now. */
  readonly busy: number;
}

interface Holder {
  kind: YtDlpSlotKind;
  readonly onPreempt: (() => void) | undefined;
  preempted: boolean;
}

interface Waiter {
  readonly kind: YtDlpSlotKind;
  readonly grant: () => void;
}

export function createYtDlpSlots(max: number = JAM_MAX_YTDLP_PROCESSES): YtDlpSlots {
  /** In the order they were granted. */
  const holders: Holder[] = [];
  /** In the order they asked. */
  const waiting: Waiter[] = [];

  function nextWaiter(): Waiter | undefined {
    return waiting.find((waiter) => waiter.kind === 'job') ?? waiting.at(-1);
  }

  function pump(): void {
    while (holders.length < max) {
      const waiter = nextWaiter();
      if (!waiter) break;
      waiting.splice(waiting.indexOf(waiter), 1);
      waiter.grant();
    }
    // Jobs still waiting: stop as many prefetches (oldest first) as are not already stopping.
    let needed =
      waiting.filter((waiter) => waiter.kind === 'job').length -
      holders.filter((holder) => holder.preempted).length;
    for (const holder of holders) {
      if (needed <= 0) break;
      const { onPreempt } = holder;
      if (holder.kind !== 'prefetch' || holder.preempted || !onPreempt) continue;
      holder.preempted = true;
      needed -= 1;
      // Never from inside `acquire`/`release`: the holder reacts on its own turn.
      queueMicrotask(onPreempt);
    }
  }

  return {
    acquire(kind, signal, onPreempt) {
      return new Promise<YtDlpSlot>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const onAbort = (): void => {
          const index = waiting.indexOf(waiter);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal?.reason);
        };
        const waiter: Waiter = {
          kind,
          grant() {
            signal?.removeEventListener('abort', onAbort);
            const holder: Holder = { kind, onPreempt, preempted: false };
            holders.push(holder);
            let released = false;
            resolve({
              promote() {
                if (released || holder.kind === 'job') return;
                holder.kind = 'job';
                holder.preempted = false;
                // A job may still wait: another prefetch has to make room instead.
                pump();
              },
              release() {
                if (released) return;
                released = true;
                holders.splice(holders.indexOf(holder), 1);
                pump();
              },
            });
          },
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        waiting.push(waiter);
        pump();
      });
    },
    get busy() {
      return holders.length;
    },
  };
}
