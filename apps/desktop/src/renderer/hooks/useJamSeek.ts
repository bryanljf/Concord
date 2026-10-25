import { useEffect, useRef, useState } from 'react';
import { jamPositionAt, type JamNowPlaying } from '@concord/shared';
import {
  JAM_SEEK_KEY_DELAY_MS,
  JAM_SEEK_SETTLE_MS,
  clampSeekPosition,
  jamSeekShown,
  jamSeekStands,
  type JamSeekOutcome,
  type JamSeekTarget,
} from '../lib/jamSeek';

/** Asks the server to move the song `itemId` (if still playing) to `positionMs` (whole ms). */
export type JamSeekRequest = (itemId: string, positionMs: number) => Promise<JamSeekOutcome>;

export interface JamSeek {
  /** The song as the bar shows it: where you just moved it until the server shows that too. */
  shown: JamNowPlaying;
  /** A click, or a drag let go, at `positionMs`: shown and sent now. */
  seekNow(positionMs: number): void;
  /** A key: shown now, sent once the keys rest (holding one sends a single seek). */
  seekSoon(positionMs: number): void;
  /** Esc: forgets a key seek not sent yet (the bar goes back); true when there was one. */
  cancelSoon(): boolean;
}

interface Latest {
  nowPlaying: JamNowPlaying;
  clockOffsetMs: number;
  request: JamSeekRequest | undefined;
  target: JamSeekTarget | null;
}

/**
 * Seeking the Jam's song from its progress bar (`lib/jamSeek.ts` decides): the position chosen
 * shows right away and moves on with the song, then the bar follows the server again once its
 * state shows the seek, the song changes, the request fails (its toast says why) or the server
 * stays silent for a few seconds after taking it. `request` undefined: nothing to seek (not in
 * the room, or no known duration).
 */
export function useJamSeek(
  nowPlaying: JamNowPlaying,
  clockOffsetMs: number,
  serverNow: number,
  request: JamSeekRequest | undefined,
): JamSeek {
  const [target, setTarget] = useState<JamSeekTarget | null>(null);
  const stands =
    target !== null && request !== undefined && jamSeekStands(target, nowPlaying, serverNow);
  // Given way once, for good: a later state never brings it back.
  if (target !== null && !stands) setTarget(null);
  const current = stands ? target : null;

  // Timers and answers act on what is current by the time they run.
  const latest = useRef<Latest>({ nowPlaying, clockOffsetMs, request, target: current });
  useEffect(() => {
    latest.current = { nowPlaying, clockOffsetMs, request, target: current };
  });

  /** The key seek waiting for the keys to rest. */
  const waiting = useRef<{ id: number; timer: number } | null>(null);
  const lastId = useRef(0);
  useEffect(
    () => () => {
      if (waiting.current) window.clearTimeout(waiting.current.timer);
    },
    [],
  );

  // The server took it but no state shows it: the bar follows the server after a while anyway.
  const settledId = current?.settled ? current.id : null;
  useEffect(() => {
    if (settledId === null) return;
    const timer = window.setTimeout(
      () => setTarget((shown) => (shown?.id === settledId ? null : shown)),
      JAM_SEEK_SETTLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [settledId]);

  function choose(positionMs: number): JamSeekTarget {
    lastId.current += 1;
    const chosen: JamSeekTarget = {
      id: lastId.current,
      itemId: nowPlaying.item.id,
      positionMs,
      at: Date.now() + clockOffsetMs,
      basis: nowPlaying,
      settled: false,
    };
    setTarget(chosen);
    return chosen;
  }

  function send(chosen: JamSeekTarget, positionMs: number): void {
    const seek = latest.current.request;
    const settle = (outcome: JamSeekOutcome): void => {
      if (outcome === 'replaced') return;
      setTarget((shown) => {
        if (shown?.id !== chosen.id) return shown;
        return outcome === 'done' ? { ...shown, settled: true } : null;
      });
    };
    if (!seek || latest.current.nowPlaying.item.id !== chosen.itemId) {
      settle('failed');
      return;
    }
    seek(chosen.itemId, positionMs).then(settle, () => settle('failed'));
  }

  function clearWaiting(): { id: number; timer: number } | null {
    const pending = waiting.current;
    if (pending) window.clearTimeout(pending.timer);
    waiting.current = null;
    return pending;
  }

  function seekNow(positionMs: number): void {
    clearWaiting();
    send(choose(positionMs), positionMs);
  }

  function seekSoon(positionMs: number): void {
    clearWaiting();
    const chosen = choose(positionMs);
    const timer = window.setTimeout(() => {
      waiting.current = null;
      const { nowPlaying: playing, clockOffsetMs: offset, target: shown } = latest.current;
      // Given way meanwhile (another song…): nothing to send.
      if (shown?.id !== chosen.id) return;
      // It waited a moment: playing, the song (and the position shown) moved on meanwhile.
      const now = jamPositionAt(jamSeekShown(playing, chosen), Date.now() + offset);
      send(chosen, clampSeekPosition(now, playing.item.track.durationMs));
    }, JAM_SEEK_KEY_DELAY_MS);
    waiting.current = { id: chosen.id, timer };
  }

  function cancelSoon(): boolean {
    const pending = clearWaiting();
    if (!pending) return false;
    setTarget((shown) => (shown?.id === pending.id ? null : shown));
    return true;
  }

  return {
    shown: current ? jamSeekShown(nowPlaying, current) : nowPlaying,
    seekNow,
    seekSoon,
    cancelSoon,
  };
}
