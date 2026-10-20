/**
 * Music apps whose audio and "now playing" can be broadcast (Spotify for now). Pure data and
 * matching only: imported by the main process and by the now-playing utility process alike.
 */
import type { MusicAppId } from '../preload/api';

export interface MusicAppDefinition {
  id: MusicAppId;
  /** Name shown in pt-BR messages ("O Spotify não está aberto."). */
  label: string;
  /** Image names of the app's processes (case-insensitive), root and children alike. */
  processNames: readonly string[];
  /**
   * Whether a Windows media session (SMTC `sourceAppId`, an AUMID or an executable name)
   * belongs to this app.
   */
  matchesAumid(aumid: string): boolean;
}

/**
 * Spotify: the spotify.com installer registers as `Spotify.exe`; the Microsoft Store build as
 * `SpotifyAB.SpotifyMusic_<publisher hash>!Spotify`. Both run as `Spotify.exe`.
 */
const SPOTIFY_STORE_AUMID = /^SpotifyAB\.SpotifyMusic_[a-z0-9]+!Spotify$/i;

export const MUSIC_APPS: Readonly<Record<MusicAppId, MusicAppDefinition>> = {
  spotify: {
    id: 'spotify',
    label: 'Spotify',
    processNames: ['Spotify.exe'],
    matchesAumid: (aumid) =>
      aumid.toLowerCase() === 'spotify.exe' || SPOTIFY_STORE_AUMID.test(aumid),
  },
};

export const MUSIC_APP_IDS = Object.keys(MUSIC_APPS) as MusicAppId[];

export function isMusicAppId(value: unknown): value is MusicAppId {
  return typeof value === 'string' && Object.hasOwn(MUSIC_APPS, value);
}

/** The music app a media session belongs to, or null for any other app (browsers, players…). */
export function musicAppFromAumid(aumid: string): MusicAppId | null {
  for (const id of MUSIC_APP_IDS) {
    if (MUSIC_APPS[id].matchesAumid(aumid)) return id;
  }
  return null;
}
