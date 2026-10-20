/**
 * Music + screen share: when the screen share's audio also carries the music app, the music goes
 * out twice (its own track and inside the screen's audio). Windows only lets a capture exclude
 * one process tree (Discord's), so this is allowed: the broadcaster is warned and viewers can
 * silence one of the two. Pure so it can be unit-tested.
 */
import type { MusicAppId, NowPlaying } from '../../preload/api';
import { MUSIC_APP_LABELS } from './music';
import { sourceKindOf } from './sourceSwitch';

/** How the screen share carries audio (`BroadcastAudioMode` in `hooks/useBroadcast.ts`). */
export type ScreenAudioMode = 'none' | 'system' | 'process';

/** What the screen share captures (or would capture), as far as its audio is concerned. */
export interface ScreenAudioSource {
  /** desktopCapturer id: `window:<hwnd>:0` or `screen:<n>:0`. */
  sourceId: string;
  /** Window title (or screen name), as listed by desktopCapturer. */
  sourceName: string;
  audio: ScreenAudioMode;
}

/** "O Spotify também vai no áudio da transmissão (…)". */
export function musicDuplicationWarning(app: MusicAppId): string {
  return (
    `O ${MUSIC_APP_LABELS[app]} também vai no áudio da transmissão (o Windows só deixa excluir ` +
    'o Discord). Quem assiste pode silenciar um dos dois.'
  );
}

/** Case, spacing and dash variants do not matter when comparing window titles. */
function normalizeTitle(text: string): string {
  return text.replace(/[‒-―]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Whether a window title looks like the music app's own window: Spotify's reads "Spotify",
 * "Spotify Premium"… while idle and "<artist> - <title>" while playing.
 */
export function looksLikeMusicAppWindow(
  app: MusicAppId,
  windowName: string,
  nowPlaying: NowPlaying | null,
): boolean {
  const name = normalizeTitle(windowName);
  if (name.length === 0) return false;
  if (name.includes(normalizeTitle(MUSIC_APP_LABELS[app]))) return true;
  if (!nowPlaying || nowPlaying.app !== app || !nowPlaying.title || !nowPlaying.artist) {
    return false;
  }
  return name === normalizeTitle(`${nowPlaying.artist} - ${nowPlaying.title}`);
}

/**
 * Whether the screen share's audio also carries `app`: the system loopback carries every app;
 * a screen's per-process capture carries everything except Discord; a window's only that window's
 * process tree (so only the music app's own window).
 */
export function screenAudioIncludesMusic(
  source: ScreenAudioSource,
  app: MusicAppId,
  nowPlaying: NowPlaying | null,
): boolean {
  switch (source.audio) {
    case 'none':
      return false;
    case 'system':
      return true;
    case 'process':
      return (
        sourceKindOf(source.sourceId) === 'screen' ||
        looksLikeMusicAppWindow(app, source.sourceName, nowPlaying)
      );
  }
}

/** The live screen share, shaped like `BroadcastState` while `live`. */
export interface LiveScreen extends ScreenAudioSource {
  startedAt: number;
}

/** The live music, shaped like `MusicBroadcastState` while `live`. */
export interface LiveMusic {
  app: MusicAppId;
  nowPlaying: NowPlaying | null;
}

/**
 * Identifies a screen live whose audio duplicates the live music, or null: the owner warns once
 * per key (one notice per screen live and music app, even across source switches).
 */
export function musicDuplicationKey(
  screen: LiveScreen | null,
  music: LiveMusic | null,
): string | null {
  if (!screen || !music) return null;
  if (!screenAudioIncludesMusic(screen, music.app, music.nowPlaying)) return null;
  return `${screen.startedAt}:${music.app}`;
}
