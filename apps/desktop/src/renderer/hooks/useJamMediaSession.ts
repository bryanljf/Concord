import { useEffect, useRef } from 'react';
import type { JamState, RoomId } from '@concord/shared';
import { useJamActions } from './useJamActions';

const ACTIONS = ['play', 'pause', 'nexttrack', 'previoustrack'] as const;

/**
 * The Jam you listen to as the phone's "now playing" (Media Session): title, artists and cover on
 * the lock screen and in the notification, with play/pause, next and previous acting on the room's
 * Jam (for everyone, like the buttons in the app). Telling the system media is playing is also what
 * keeps a phone browser from freezing the page while the screen is locked. Off when `enabled` is
 * false or the browser has no Media Session.
 */
export function useJamMediaSession(enabled: boolean, room: RoomId | null, jam: JamState | null) {
  const actions = useJamActions();
  // The handlers read the latest values without being re-registered on every jam event.
  const latest = useRef({ room, jam, actions });
  useEffect(() => {
    latest.current = { room, jam, actions };
  });

  const active = enabled && room !== null && jam !== null && 'mediaSession' in navigator;
  const current = active ? (jam?.current ?? null) : null;
  const track = current?.item.track ?? null;

  useEffect(() => {
    if (!active) return;
    const session = navigator.mediaSession;
    const handle = (action: (typeof ACTIONS)[number]) => () => {
      const { room: target, jam: state, actions: jamActions } = latest.current;
      if (!target || !state) return;
      const itemId = state.current?.item.id ?? null;
      if (action === 'play') jamActions.resume(target);
      else if (action === 'pause') jamActions.pause(target);
      else if (action === 'nexttrack' && itemId) jamActions.skip(target, itemId);
      else if (action === 'previoustrack') jamActions.previous(target, itemId);
    };
    for (const action of ACTIONS) {
      try {
        session.setActionHandler(action, handle(action));
      } catch {
        // An action this browser does not support.
      }
    }
    return () => {
      for (const action of ACTIONS) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Same as above.
        }
      }
      session.metadata = null;
      session.playbackState = 'none';
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const session = navigator.mediaSession;
    session.metadata = track
      ? new MediaMetadata({
          title: track.title,
          artist: track.artists,
          album: track.album ?? 'Jam do Concord',
          artwork: track.artworkUrl ? [{ src: track.artworkUrl, sizes: '512x512' }] : [],
        })
      : new MediaMetadata({ title: 'Jam do Concord' });
  }, [active, track]);

  const paused = current?.paused ?? true;
  useEffect(() => {
    if (!active) return;
    navigator.mediaSession.playbackState = current ? (paused ? 'paused' : 'playing') : 'none';
  }, [active, current, paused]);
}
