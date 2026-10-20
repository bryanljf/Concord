/**
 * The music track: an app's audio (Spotify for now) published apart from the screen share, plus
 * what it is playing. Shared by the broadcaster (`hooks/useMusicBroadcast.ts`) and the listeners
 * (`hooks/useRemoteMusic.ts`), and pure so it can be unit-tested.
 *
 * - The audio goes out as `Track.Source.Microphone` named `concord:music:<app>` (the app never
 *   captures a microphone: the source only keeps its volume apart from the screen's, and older
 *   clients, which only look for ScreenShareAudio, ignore it).
 * - What it plays travels in the `concord.music` participant attribute (no cover art, small).
 * - The cover art is fetched with the `concord.music.art` RPC, by `artId`.
 */
import type { MusicAppId, NowPlaying } from '../../preload/api';

export const MUSIC_APPS: readonly MusicAppId[] = ['spotify'];

export const MUSIC_APP_LABELS: Readonly<Record<MusicAppId, string>> = { spotify: 'Spotify' };

const TRACK_NAME_PREFIX = 'concord:music:';

/** `concord:music:spotify`. */
export function musicTrackName(app: MusicAppId): string {
  return `${TRACK_NAME_PREFIX}${app}`;
}

/** The app of a music track name; null for any other track. */
export function parseMusicTrackName(name: string): MusicAppId | null {
  if (!name.startsWith(TRACK_NAME_PREFIX)) return null;
  const app = name.slice(TRACK_NAME_PREFIX.length);
  return (MUSIC_APPS as readonly string[]).includes(app) ? (app as MusicAppId) : null;
}

/** livekit `TrackPublishOptions.stream`: never A/V-synced with the screen share or the camera. */
export const MUSIC_STREAM = 'music';

/** Participant attribute carrying what the broadcaster's music app plays. */
export const MUSIC_ATTRIBUTE = 'concord.music';

/** RPC answered by the broadcaster with the cover art of `{ artId }` (base64 JPEG). */
export const MUSIC_ART_RPC = 'concord.music.art';

/** livekit caps RPC payloads at 15 KiB; the cover is resized in main to stay well below. */
export const MUSIC_ART_MAX_BASE64 = 15_000;

const STATES: readonly NowPlaying['state'][] = ['playing', 'paused', 'stopped'];
const TEXT_MAX = 200;

/** Compact JSON for the attribute; `null` (nothing playing) encodes as `{"app":…}` only. */
export function encodeMusicAttribute(app: MusicAppId, nowPlaying: NowPlaying | null): string {
  if (!nowPlaying) return JSON.stringify({ v: 1, app });
  const clip = (text: string) => text.slice(0, TEXT_MAX);
  return JSON.stringify({
    v: 1,
    app,
    t: clip(nowPlaying.title),
    a: clip(nowPlaying.artist),
    al: clip(nowPlaying.album),
    s: nowPlaying.state,
    ad: nowPlaying.ad ? 1 : 0,
    p: Math.round(nowPlaying.positionMs),
    d: Math.round(nowPlaying.durationMs),
    at: Math.round(nowPlaying.at),
    art: nowPlaying.artId,
  });
}

export interface MusicAttribute {
  app: MusicAppId;
  /** Null while the app plays nothing. */
  nowPlaying: NowPlaying | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;

const text = (value: unknown): string =>
  typeof value === 'string' ? value.slice(0, TEXT_MAX) : '';

/** Defensive decode of `MUSIC_ATTRIBUTE`; null for a missing, foreign or broken value. */
export function decodeMusicAttribute(raw: string | undefined): MusicAttribute | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  const app = parsed.app;
  if (typeof app !== 'string' || !(MUSIC_APPS as readonly string[]).includes(app)) return null;
  const musicApp = app as MusicAppId;
  if (typeof parsed.t !== 'string') return { app: musicApp, nowPlaying: null };
  const state = STATES.includes(parsed.s as NowPlaying['state'])
    ? (parsed.s as NowPlaying['state'])
    : 'stopped';
  return {
    app: musicApp,
    nowPlaying: {
      app: musicApp,
      title: text(parsed.t),
      artist: text(parsed.a),
      album: text(parsed.al),
      state,
      ad: parsed.ad === 1,
      positionMs: finiteOr(parsed.p, 0),
      durationMs: finiteOr(parsed.d, 0),
      at: finiteOr(parsed.at, 0),
      artId: typeof parsed.art === 'string' && parsed.art.length <= 64 ? parsed.art : null,
    },
  };
}

/**
 * Where the music is now: the position frozen at `at`, moving on with the clock while playing
 * (clamped to the duration). Clocks differ a little between PCs; the bar only needs to look right.
 */
export function extrapolatePosition(nowPlaying: NowPlaying, now: number): number {
  if (nowPlaying.state !== 'playing') return Math.min(nowPlaying.positionMs, nowPlaying.durationMs);
  const elapsed = Math.max(0, now - nowPlaying.at);
  const position = nowPlaying.positionMs + elapsed;
  return nowPlaying.durationMs > 0 ? Math.min(position, nowPlaying.durationMs) : position;
}

/** "3:07" / "1:02:03". */
export function formatTrackTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * Whether two snapshots differ enough to re-publish the attribute: another track, state or cover,
 * or a position jump (seek) beyond what the clock explains. Never re-sent every second.
 */
export function musicChanged(previous: NowPlaying | null, next: NowPlaying | null): boolean {
  if (previous === null || next === null) return previous !== next;
  if (
    previous.title !== next.title ||
    previous.artist !== next.artist ||
    previous.album !== next.album ||
    previous.state !== next.state ||
    previous.ad !== next.ad ||
    previous.artId !== next.artId ||
    previous.durationMs !== next.durationMs
  ) {
    return true;
  }
  const expected = extrapolatePosition(previous, next.at);
  return Math.abs(expected - next.positionMs) > SEEK_TOLERANCE_MS;
}

/** A position this far from the extrapolated one is a seek. */
export const SEEK_TOLERANCE_MS = 2_000;

/**
 * A new reading this much behind the current anchor is stale (Spotify refreshes its position
 * only every few seconds; a clock difference between PCs adds a little), not a seek back.
 */
export const STALE_POSITION_MS = 5_000;

/**
 * What the progress bar should follow after `next` arrives: while the same track keeps playing,
 * a reading slightly behind the current anchor keeps the anchor, so the bar never jumps back a
 * few seconds; a fresher reading, a seek forward, a seek back beyond the margin, another track
 * or a state change is taken as it is.
 */
export function steadyNowPlaying(previous: NowPlaying | null, next: NowPlaying): NowPlaying {
  if (previous === null || previous.state !== 'playing' || next.state !== 'playing') return next;
  if (
    previous.title !== next.title ||
    previous.artist !== next.artist ||
    previous.album !== next.album
  ) {
    return next;
  }
  const anchor = previous.positionMs - previous.at;
  const reading = next.positionMs - next.at;
  if (reading >= anchor || anchor - reading > STALE_POSITION_MS) return next;
  return { ...next, positionMs: next.at + anchor };
}
