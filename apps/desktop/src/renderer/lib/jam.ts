/**
 * The Jam on the listener's side: a YouTube Music queue per room, played by the server's jam bot
 * (identity `@jam`, one stereo track `concord:music:jam`). What it plays, the queue and who asked
 * for what come from the jam state main streams next to presence (never from LiveKit attributes);
 * the audio is listened to on demand (`hooks/useMusicListening.ts`). Pure so it can be
 * unit-tested; `hooks/useJam.ts` and `components/jam/*` drive the UI with it.
 */
import {
  JAM_BOT_IDENTITY,
  JAM_SEARCH_MAX_LENGTH,
  jamPositionAt,
  parseYouTubeVideoId,
  type JamItem,
  type JamNowPlaying,
  type JamState,
  type JamTrack,
  type RoomId,
} from '@concord/shared';
import type { JamUploadStatus } from '../../preload/api';
import { pluralize } from './format';
import { formatTrackTime } from './music';
import type { MusicProgress } from './musicListening';
import type { PresenceProfile } from './presence';

// --- Server clock --------------------------------------------------------------------------

/** One reading of the server clock: `serverTime - Date.now()` when a jam message arrived. */
export interface JamClockSample {
  offsetMs: number;
  /** Local `Date.now()` when it arrived. */
  receivedAt: number;
}

/** Readings older than this are forgotten (the local clock may have been adjusted since). */
export const JAM_CLOCK_WINDOW_MS = 10 * 60_000;

/** At most this many readings are kept. */
export const JAM_CLOCK_MAX_SAMPLES = 8;

/**
 * Adds a reading (`serverTime` of a jam message, received at `receivedAt`), keeping the recent
 * ones. Readings "from the future" (the local clock went back since) are dropped.
 */
export function addJamClockSample(
  samples: readonly JamClockSample[],
  serverTime: number,
  receivedAt: number,
): readonly JamClockSample[] {
  // 0 is main's placeholder before the server answered: no reading at all.
  if (!Number.isFinite(serverTime) || serverTime <= 0 || !Number.isFinite(receivedAt)) {
    return samples;
  }
  const recent = samples.filter(
    (sample) =>
      sample.receivedAt <= receivedAt && receivedAt - sample.receivedAt <= JAM_CLOCK_WINDOW_MS,
  );
  return [...recent, { offsetMs: serverTime - receivedAt, receivedAt }].slice(
    -JAM_CLOCK_MAX_SAMPLES,
  );
}

/**
 * How far the server clock is ahead of this PC's (ms; negative when behind). Every reading is a
 * lower bound (the message spent some time on the way, and a snapshot main kept for a while is
 * older still), so the largest recent one is the best guess. 0 without readings.
 */
export function jamClockOffset(samples: readonly JamClockSample[]): number {
  let best: number | null = null;
  for (const sample of samples) {
    if (best === null || sample.offsetMs > best) best = sample.offsetMs;
  }
  return best ?? 0;
}

/** The progress bar of the song playing at `serverNow` (`Date.now()` + the clock offset). */
export function jamProgress(nowPlaying: JamNowPlaying, serverNow: number): MusicProgress {
  const durationMs = nowPlaying.item.track.durationMs;
  const positionMs = jamPositionAt(nowPlaying, serverNow);
  const fraction = durationMs > 0 ? Math.min(1, Math.max(0, positionMs / durationMs)) : 0;
  return { positionMs, durationMs, fraction };
}

// --- Cover art -----------------------------------------------------------------------------

/**
 * The `<img>` source of a song's cover: https on `*.googleusercontent.com` or `i.ytimg.com` (what
 * the CSP `img-src` allows), anything else null (the placeholder note).
 */
export function jamArtworkSrc(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const host = parsed.hostname.toLowerCase();
  const allowed = host === 'i.ytimg.com' || host.endsWith('.googleusercontent.com');
  return allowed ? parsed.href : null;
}

// --- Search --------------------------------------------------------------------------------

/** Searches start from this many characters. */
export const JAM_SEARCH_MIN_LENGTH = 2;

/** Typing pauses this long before a search goes out. */
export const JAM_SEARCH_DEBOUNCE_MS = 350;

/** The search shows only the best few results. */
export const JAM_RESULTS_SHOWN = 4;

/** What the search box holds. */
export type JamQueryIntent =
  | { kind: 'empty' }
  /** Fewer than `JAM_SEARCH_MIN_LENGTH` characters. */
  | { kind: 'short' }
  | { kind: 'too_long' }
  /** A YouTube / YouTube Music link: "Adicionar link" straight away, no search. */
  | { kind: 'link'; videoId: string }
  /** A link to another site (another music service, a page…): only YouTube links work. */
  | { kind: 'foreign_link' }
  | { kind: 'search'; query: string };

const URL_LIKE = /^https?:\/\/\S+$|^[\w-]+(?:\.[\w-]+)+\/\S*$/i;

/**
 * Reads the search box: a YouTube link (`parseYouTubeVideoId`) is added directly; a bare video id
 * is searched like any text (an 11-letter word looks the same); other links are refused; text is
 * searched once it has 2 to 100 characters (spaces collapsed).
 */
export function jamQueryIntent(input: string): JamQueryIntent {
  const value = input.trim();
  if (value.length === 0) return { kind: 'empty' };
  const videoId = parseYouTubeVideoId(value);
  if (videoId && videoId !== value) return { kind: 'link', videoId };
  if (URL_LIKE.test(value)) return { kind: 'foreign_link' };
  const query = value.replace(/\s+/g, ' ');
  if (query.length < JAM_SEARCH_MIN_LENGTH) return { kind: 'short' };
  if (query.length > JAM_SEARCH_MAX_LENGTH) return { kind: 'too_long' };
  return { kind: 'search', query };
}

/** The hint under the search box for the intents that do not search; null otherwise. */
export function jamQueryHint(intent: JamQueryIntent): string | null {
  switch (intent.kind) {
    case 'short':
      return `Digite pelo menos ${JAM_SEARCH_MIN_LENGTH} letras para buscar.`;
    case 'too_long':
      return `Busca muito longa: até ${JAM_SEARCH_MAX_LENGTH} caracteres.`;
    case 'foreign_link':
      return 'Só links do YouTube ou do YouTube Music.';
    default:
      return null;
  }
}

/** "6:09", or "–:––" without a known duration. */
export function jamDurationLabel(durationMs: number): string {
  return durationMs > 0 ? formatTrackTime(durationMs) : '–:––';
}

/** "Random Access Memories · 6:09" (just the duration without an album). */
export function jamTrackDetail(track: JamTrack): string {
  const duration = jamDurationLabel(track.durationMs);
  return track.album ? `${track.album} · ${duration}` : duration;
}

/** "Get Lucky — Daft Punk, Pharrell Williams" (tooltips, accessible names). */
export function jamTrackLine(track: JamTrack): string {
  return track.artists ? `${track.title} — ${track.artists}` : track.title;
}

// --- Prefetch ------------------------------------------------------------------------------

/** A result stays hovered or focused this long before its download starts ahead of time. */
export const JAM_PREFETCH_DELAY_MS = 150;

/** Timers, injectable for the tests. */
export interface JamPrefetchTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_PREFETCH_TIMERS: JamPrefetchTimers = {
  set: (callback, ms) => globalThis.setTimeout(callback, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Asks main to download songs ahead of time while the search dialog is open, so adding one is
 * near-instant (main prefetches the top result by itself). Each song at most once per dialog.
 */
export interface JamPrefetcher {
  /** A result was hovered or focused: prefetched once it stays so for the delay. */
  intend(videoId: string): void;
  /** The pointer or the focus left it before the delay: nothing goes out. */
  cancel(videoId: string): void;
  /** Right away (a YouTube link was pasted). */
  now(videoId: string): void;
  /** The dialog closed: the pending one is dropped (the ones already sent stay sent). */
  clear(): void;
}

export function createJamPrefetcher(
  send: (videoId: string) => void,
  delayMs: number = JAM_PREFETCH_DELAY_MS,
  timers: JamPrefetchTimers = DEFAULT_PREFETCH_TIMERS,
): JamPrefetcher {
  const sent = new Set<string>();
  let pending: { videoId: string; handle: unknown } | null = null;

  const drop = (): void => {
    if (pending) timers.clear(pending.handle);
    pending = null;
  };
  const fire = (videoId: string): void => {
    if (sent.has(videoId)) return;
    sent.add(videoId);
    send(videoId);
  };

  return {
    intend(videoId) {
      if (sent.has(videoId) || pending?.videoId === videoId) return;
      drop();
      const handle = timers.set(() => {
        pending = null;
        fire(videoId);
      }, delayMs);
      pending = { videoId, handle };
    },
    cancel(videoId) {
      if (pending?.videoId === videoId) drop();
    },
    now(videoId) {
      if (pending?.videoId === videoId) drop();
      fire(videoId);
    },
    clear: drop,
  };
}

// --- People --------------------------------------------------------------------------------

/** Who asked for a song or paused the Jam, ready to show. */
export interface JamPerson {
  id: string;
  name: string;
  avatarUrl: string | null;
  /** It is you ("pedida por você"). */
  self: boolean;
}

export interface JamSelf {
  id: string;
  name: string;
  avatarUrl: string | null;
}

/** Name and avatar from presence (they follow nickname changes); the user id when unknown. */
export function jamPerson(
  id: string,
  profiles: ReadonlyMap<string, PresenceProfile>,
  self: JamSelf,
): JamPerson {
  if (id === self.id) return { id, name: self.name, avatarUrl: self.avatarUrl, self: true };
  const profile = profiles.get(id);
  return { id, name: profile?.name || id, avatarUrl: profile?.avatarUrl ?? null, self: false };
}

/** "Pedida por Ana" / "Pedida por você" (the requester's avatar tooltip). */
export function requestedByLabel(person: JamPerson): string {
  return person.self ? 'Pedida por você' : `Pedida por ${person.name}`;
}

/** "Pausada por Ana" / "Pausada por você" / "Pausada" (nobody known). */
export function pausedByLabel(person: JamPerson | null): string {
  if (!person) return 'Pausada';
  return person.self ? 'Pausada por você' : `Pausada por ${person.name}`;
}

// --- Queue ---------------------------------------------------------------------------------

/**
 * The badge of a song still on its way: your own songs say where they are (preparing the
 * downloader, downloading from YouTube, sending to the server); anyone else's say "Baixando…"
 * until the server has the audio. Null once it is playable: the server marks it `ready` while
 * the audio still streams in (it may already be playing, so no "Enviando…" then), and your app
 * having sent it all (`done`) means the same even before the state says so.
 */
export function jamItemStatusLabel(item: JamItem, upload?: JamUploadStatus): string | null {
  if (item.status === 'ready') return null;
  if (upload && upload.itemId === item.id) {
    switch (upload.state) {
      case 'preparing':
        return 'Preparando…';
      case 'downloading':
        return 'Baixando…';
      case 'uploading':
        return 'Enviando…';
      case 'done':
        return null;
      default:
        break;
    }
  }
  return 'Baixando…';
}

/**
 * What to remember about a song `addToJam` just resolved with: one the server already had (its
 * cache, or a prefetch that finished) comes back `ready` and counts as sent, so it never shows
 * "Baixando…", whatever arrives later. Null for one still to send (main reports its progress).
 */
export function jamAddedStatus(room: RoomId, item: JamItem): JamUploadStatus | null {
  if (item.status !== 'ready') return null;
  return { itemId: item.id, room, title: item.track.title, state: 'done', message: null };
}

/**
 * Main's statuses of your songs with the ones noted when adding on top (`jamAddedStatus`: the
 * server already had those). `uploads` itself when nothing was noted.
 */
export function withAddedStatuses(
  uploads: ReadonlyMap<string, JamUploadStatus>,
  added: ReadonlyMap<string, JamUploadStatus>,
): ReadonlyMap<string, JamUploadStatus> {
  if (added.size === 0) return uploads;
  const merged = new Map(uploads);
  for (const [itemId, status] of added) merged.set(itemId, status);
  return merged;
}

/** One song of "A seguir", ready to show. */
export interface JamQueueEntry {
  item: JamItem;
  /** 1 for the next song. */
  position: number;
  requester: JamPerson;
  /** "Baixando…" and the like; null when ready. */
  statusLabel: string | null;
}

export function jamQueueEntries(
  queue: readonly JamItem[],
  uploads: ReadonlyMap<string, JamUploadStatus>,
  person: (id: string) => JamPerson,
): JamQueueEntry[] {
  return queue.map((item, index) => ({
    item,
    position: index + 1,
    requester: person(item.requestedBy),
    statusLabel: jamItemStatusLabel(item, uploads.get(item.id)),
  }));
}

/** The first `max` songs and how many more there are (the compact queue in the search). */
export function jamQueuePreview<T>(queue: readonly T[], max: number): { shown: T[]; more: number } {
  const shown = queue.slice(0, Math.max(0, max));
  return { shown, more: queue.length - shown.length };
}

/** "Nenhuma música na fila" / "1 música na fila" / "3 músicas na fila". */
export function jamQueueSummary(count: number): string {
  if (count === 0) return 'Nenhuma música na fila';
  return `${pluralize(count, 'música', 'músicas')} na fila`;
}

/** The queue's empty state: with a song playing, or with nothing at all yet. */
export function jamEmptyQueueText(playing: boolean): string {
  return playing
    ? 'Nenhuma música na fila. Adicione a próxima.'
    : 'Nenhuma música na fila. Busque uma música para começar a Jam.';
}

// --- Rooms ---------------------------------------------------------------------------------

/** Nothing playing nor queued: a song added now starts right away ("Tocando agora"). */
export function jamRoomIdle(state: JamState | null | undefined): boolean {
  return !state || (state.current === null && state.queue.length === 0);
}

/** The toast after adding a song: "Tocando agora: …" in an idle room, "Na fila: …" otherwise. */
export function jamAddedMessage(title: string, roomWasIdle: boolean): string {
  return roomWasIdle ? `Tocando agora: ${title}` : `Na fila: ${title}`;
}

/** The toast when your app could not send a song: "Não foi possível adicionar “…”: …". */
export function jamUploadErrorMessage(status: JamUploadStatus): string {
  const reason = status.message?.trim() || 'Tente novamente.';
  return `Não foi possível adicionar “${status.title}”: ${reason}`;
}

/**
 * What a room's music indicator says about its Jam ("Jam: Get Lucky — Daft Punk"); while only
 * songs on their way are queued, that it is getting ready. Null without a Jam.
 */
export function jamIndicatorLabel(state: JamState | null | undefined): string | null {
  if (!state) return null;
  if (state.current) return `Jam: ${jamTrackLine(state.current.item.track)}`;
  return state.queue.length > 0 ? 'Jam: preparando a primeira música' : null;
}

/** The tooltip of a room's Jam indicator: its line, and "ouvindo" while you listen to it. */
export function jamIndicatorSummary(jamLabel: string, listening: boolean): string {
  return listening ? `${jamLabel} · ouvindo` : jamLabel;
}

/** A song is playing (not paused): the indicator's bars bounce; frozen otherwise. */
export function jamPlaying(state: JamState | null | undefined): boolean {
  return state?.current != null && !state.current.paused;
}

const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });

/**
 * The Jams the room's connection cannot play: every room but the one you are connected to
 * (while connecting or disconnected, the current room's too), in the sidebar's order.
 */
export function jamsElsewhere(
  rooms: Readonly<Record<RoomId, JamState>>,
  order: readonly RoomId[],
  currentRoom: RoomId | null,
  connected: boolean,
): JamState[] {
  const rank = (room: RoomId): number => {
    const index = order.indexOf(room);
    return index === -1 ? order.length : index;
  };
  return Object.values(rooms)
    .filter((state) => !jamRoomIdle(state) && (!connected || state.room !== currentRoom))
    .sort((a, b) => rank(a.room) - rank(b.room) || collator.compare(a.room, b.room));
}

const NOT_LISTENABLE: readonly string[] = [];
const JAM_LISTENABLE: readonly string[] = [JAM_BOT_IDENTITY];

/**
 * Music that stays listened to while its track is not published: the Jam of the room you are
 * connected to, between songs or before the first one is ready ("Ouvir" sticks, the audio comes
 * when the jam bot publishes). Stable references.
 */
export function jamListenable(
  available: boolean,
  rooms: Readonly<Record<RoomId, JamState>>,
  currentRoom: RoomId | null,
  connected: boolean,
): readonly string[] {
  if (!available || !connected || currentRoom === null) return NOT_LISTENABLE;
  return jamRoomIdle(rooms[currentRoom]) ? NOT_LISTENABLE : JAM_LISTENABLE;
}
