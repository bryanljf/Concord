/**
 * "Recentes" in the music drawer: the songs the server still has (its audio cache keeps the ones
 * used in the last 3 h), most recently played first; adding one is instant, no download. Pure so
 * it can be unit-tested; `hooks/useJamRecent.ts` asks main for the list and
 * `components/jam/JamRecent.tsx` shows the button and the drawer's second column.
 */
import { JAM_CACHE_TTL_MS, type JamRecentTrack } from '@concord/shared';
import { formatElapsed } from './format';
import { jamDurationLabel, jamTrackDetail, jamTrackLine } from './jam';

const HOUR_MS = 60 * 60_000;

/** While the drawer is open, the list is asked for again this often. */
export const JAM_RECENT_REFRESH_MS = 30_000;

/**
 * "Recentes" shows in the drawer's Jam header only with the drawer open, in a room with a Jam
 * (your own: songs are added there) and at least one song the server still has.
 */
export function jamRecentButtonShown(
  drawerOpen: boolean,
  inRoomJam: boolean,
  count: number,
): boolean {
  return drawerOpen && inRoomJam && count > 0;
}

/** The music drawer's width (its main column, which keeps it while "Recentes" is open). */
export const MUSIC_DRAWER_WIDTH = 468;
/** "Recentes"' column beside it: this wide when the stage has room, never under the minimum. */
export const JAM_RECENT_COLUMN_WIDTH = 320;
export const JAM_RECENT_COLUMN_MIN_WIDTH = 240;
/** The drawer always leaves this much of the stage free on its right. */
export const MUSIC_DRAWER_STAGE_MARGIN = 24;

/** Widths in px of the music drawer and its columns (`recent`: 0 with "Recentes" closed). */
export interface MusicDrawerLayout {
  drawer: number;
  main: number;
  recent: number;
}

/**
 * The music drawer's widths on a stage `stageWidth` px wide: the main column keeps its width, and
 * "Recentes" (`expanded`) widens the drawer by its column. When the stage is too narrow the column
 * gives up width first (down to its minimum), then the main column; the drawer always fits.
 */
export function musicDrawerLayout(stageWidth: number, expanded: boolean): MusicDrawerLayout {
  const room = Math.max(0, Math.floor(stageWidth) - MUSIC_DRAWER_STAGE_MARGIN);
  if (!expanded) {
    const width = Math.min(MUSIC_DRAWER_WIDTH, room);
    return { drawer: width, main: width, recent: 0 };
  }
  const drawer = Math.min(MUSIC_DRAWER_WIDTH + JAM_RECENT_COLUMN_WIDTH, room);
  const recent = Math.min(
    drawer,
    Math.max(JAM_RECENT_COLUMN_MIN_WIDTH, drawer - MUSIC_DRAWER_WIDTH),
  );
  return { drawer, main: drawer - recent, recent };
}

/** The tooltip of "Recentes": "Músicas tocadas nas últimas 3 horas" (the server's cache). */
export function jamRecentToggleTitle(cacheTtlMs: number = JAM_CACHE_TTL_MS): string {
  const hours = Math.max(1, Math.round(cacheTtlMs / HOUR_MS));
  return hours === 1
    ? 'Músicas tocadas na última hora'
    : `Músicas tocadas nas últimas ${hours} horas`;
}

/**
 * When a recent song was last played (`usedAt`, server clock) as of `serverNow`: "tocada agora",
 * "tocada há 5 min", "tocada há 2 h". A time slightly ahead (clock drift) reads "agora"; null
 * without a usable time.
 */
export function jamRecentPlayedLabel(usedAt: number, serverNow: number): string | null {
  if (!Number.isFinite(usedAt) || usedAt <= 0 || !Number.isFinite(serverNow)) return null;
  const elapsed = formatElapsed(Math.max(0, serverNow - usedAt));
  return elapsed === 'agora' ? 'tocada agora' : `tocada há ${elapsed}`;
}

/** One card of "Recentes", ready to show. */
export interface JamRecentEntry {
  track: JamRecentTrack;
  /** "tocada há 5 min"; null without a usable time. */
  playedLabel: string | null;
  /** The card's last line: "6:09 · tocada há 5 min" (just the duration without a time). */
  meta: string;
  /**
   * The "+"'s accessible name, like a search result's plus when it played: "Adicionar Get Lucky —
   * Daft Punk (Random Access Memories · 6:09), tocada há 5 min".
   */
  label: string;
}

function usedAtOf(track: JamRecentTrack): number {
  return Number.isFinite(track.usedAt) ? track.usedAt : 0;
}

/**
 * The list as shown at `localNow` (`Date.now()`), reading the server clock through `clockOffsetMs`
 * (`hooks/useJam.ts`): most recently played first (the server already sends them so; ties keep its
 * order) and each song once, at its most recent use.
 */
export function jamRecentEntries(
  tracks: readonly JamRecentTrack[],
  localNow: number,
  clockOffsetMs: number,
): JamRecentEntry[] {
  const serverNow = localNow + clockOffsetMs;
  const seen = new Set<string>();
  const entries: JamRecentEntry[] = [];
  for (const track of [...tracks].sort((a, b) => usedAtOf(b) - usedAtOf(a))) {
    if (seen.has(track.videoId)) continue;
    seen.add(track.videoId);
    const playedLabel = jamRecentPlayedLabel(track.usedAt, serverNow);
    const duration = jamDurationLabel(track.durationMs);
    const line = jamTrackLine({ ...track, title: track.title || 'Sem título' });
    const name = `Adicionar ${line} (${jamTrackDetail(track)})`;
    entries.push({
      track,
      playedLabel,
      meta: playedLabel ? `${duration} · ${playedLabel}` : duration,
      label: playedLabel ? `${name}, ${playedLabel}` : name,
    });
  }
  return entries;
}
