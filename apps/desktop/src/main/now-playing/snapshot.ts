/**
 * Pure mapping from the SMTC snapshots posted by the worker to the `NowPlaying` / `MusicAppStatus`
 * the renderer receives, plus the rule that decides when a change is worth a push.
 */
import type { MusicAppId, MusicAppStatus, NowPlaying } from '../../preload/api';
import type { SessionSnapshot } from './protocol';

/** SMTC playback status values the mapping cares about. */
const PLAYBACK = { CHANGING: 2, PLAYING: 4, PAUSED: 5 } as const;

/** A position this far from the extrapolated one is a seek (same rule as the renderer's). */
export const SEEK_TOLERANCE_MS = 2_000;

/**
 * Spotify refreshes its media-session position only every few seconds, so a reading can lag the
 * real position by up to that much while its timestamp says "now" (measured: readings 3 s behind,
 * then 3 s ahead of each other). A reading this much behind the current anchor is taken as stale,
 * not as a seek back; anything ahead of it is fresher (or a seek forward) and becomes the anchor.
 */
export const STALE_POSITION_MS = 5_000;

/** Playing / paused as reported; "changing" keeps what it was (track switch); else stopped. */
export function playbackState(
  status: number,
  previous: NowPlaying['state'] | null,
): NowPlaying['state'] {
  if (status === PLAYBACK.PLAYING) return 'playing';
  if (status === PLAYBACK.PAUSED) return 'paused';
  if (status === PLAYBACK.CHANGING) return previous ?? 'stopped';
  return 'stopped';
}

/**
 * Spotify ads come without artist and album, titled with the advertiser, "Advertisement" or
 * "Spotify".
 */
export function isAdvertisement(title: string, artist: string, album: string): boolean {
  if (artist === '' && album === '') return true;
  return /^(advertisement|spotify)$/i.test(title);
}

/** The session to show when an app has several: playing first, then paused, then the newest. */
export function pickSession(sessions: readonly SessionSnapshot[]): SessionSnapshot | null {
  const rank = (session: SessionSnapshot): number =>
    session.playbackStatus === PLAYBACK.PLAYING
      ? 2
      : session.playbackStatus === PLAYBACK.PAUSED
        ? 1
        : 0;
  let best: SessionSnapshot | null = null;
  for (const session of sessions) {
    if (
      best === null ||
      rank(session) > rank(best) ||
      (rank(session) === rank(best) && session.lastUpdatedTime > best.lastUpdatedTime)
    ) {
      best = session;
    }
  }
  return best;
}

function sameTrack(previous: NowPlaying, title: string, artist: string, album: string): boolean {
  return previous.title === title && previous.artist === artist && previous.album === album;
}

const toMs = (seconds: number): number =>
  Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;

/**
 * `NowPlaying` for one session. `artId` is the cover main can serve (null when it has none); a
 * cover that disappears for the same track keeps the previous one, a new cover replaces it.
 * Returns null for an empty session (app open, nothing loaded).
 */
export function buildNowPlaying(
  app: MusicAppId,
  session: SessionSnapshot,
  previous: NowPlaying | null,
  artId: string | null,
  now: number,
): NowPlaying | null {
  const title = session.title.trim();
  const artist = session.artist.trim();
  const album = session.album.trim();
  const state = playbackState(session.playbackStatus, previous?.state ?? null);
  if (title === '' && artist === '' && album === '' && state !== 'playing') return null;

  const durationMs = toMs(session.durationSec);
  const rawPosition = toMs(session.positionSec);
  const positionMs = durationMs > 0 ? Math.min(rawPosition, durationMs) : rawPosition;
  const updated = session.lastUpdatedTime;
  const at = Number.isFinite(updated) && updated > 0 ? Math.min(updated, now) : now;
  const same = previous !== null && sameTrack(previous, title, artist, album);
  const keptArt = same ? previous.artId : null;
  const anchored = same ? steadyPosition(previous, state, positionMs, at) : positionMs;

  return {
    app,
    title,
    artist,
    album,
    state,
    ad: isAdvertisement(title, artist, album),
    positionMs: anchored,
    durationMs,
    at,
    artId: artId ?? keptArt,
  };
}

/**
 * The position to report while the same track keeps playing: readings never run ahead of the
 * real position, only behind it, so the freshest one so far (largest position minus timestamp)
 * is kept as the anchor and a reading slightly behind it is ignored. Without this the progress
 * bar jumped back a few seconds now and then. A state change, or a reading far behind (a real
 * seek back), takes the reading as it is.
 */
function steadyPosition(
  previous: NowPlaying,
  state: NowPlaying['state'],
  positionMs: number,
  at: number,
): number {
  if (state !== 'playing' || previous.state !== 'playing') return positionMs;
  const anchor = previous.positionMs - previous.at;
  const reading = positionMs - at;
  if (reading >= anchor || anchor - reading > STALE_POSITION_MS) return positionMs;
  const kept = at + anchor;
  return previous.durationMs > 0 ? Math.min(kept, previous.durationMs) : kept;
}

/** Position at `now`: frozen unless playing, clamped to the duration. */
export function extrapolatePosition(nowPlaying: NowPlaying, now: number): number {
  if (nowPlaying.state !== 'playing') return nowPlaying.positionMs;
  const position = nowPlaying.positionMs + Math.max(0, now - nowPlaying.at);
  return nowPlaying.durationMs > 0 ? Math.min(position, nowPlaying.durationMs) : position;
}

/**
 * Whether `next` must be pushed after `previous` (the last status pushed): the app opened or
 * closed, the track, state, cover or duration changed, or the position jumped (seek) beyond what
 * the clock explains. Regular timeline ticks are not pushed: the renderer extrapolates.
 */
export function musicStatusChanged(previous: MusicAppStatus | null, next: MusicAppStatus): boolean {
  if (previous === null || previous.app !== next.app || previous.running !== next.running) {
    return true;
  }
  const before = previous.nowPlaying;
  const after = next.nowPlaying;
  if (before === null || after === null) return before !== after;
  if (
    before.title !== after.title ||
    before.artist !== after.artist ||
    before.album !== after.album ||
    before.state !== after.state ||
    before.ad !== after.ad ||
    before.artId !== after.artId ||
    before.durationMs !== after.durationMs
  ) {
    return true;
  }
  return Math.abs(extrapolatePosition(before, after.at) - after.positionMs) > SEEK_TOLERANCE_MS;
}
