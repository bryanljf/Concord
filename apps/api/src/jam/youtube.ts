import type { Innertube } from 'youtubei.js';
import { JAM_SEARCH_LIMIT, YOUTUBE_VIDEO_ID_PATTERN, type JamTrack } from '@concord/shared';

/**
 * What the Jam asks YouTube Music. Only search and "up next" (`/next`): from the server's IP every
 * player endpoint (getInfo, getBasicInfo, streaming data, download) answers "Sign in to confirm
 * you're not a bot", so the api never calls them; the audio comes from the requester's app.
 */
export interface YouTubeMusic {
  /** Songs for `query` (at most JAM_SEARCH_LIMIT). Rejects with YouTubeMusicError. */
  search(query: string): Promise<JamTrack[]>;
  /** One video's metadata; null when YouTube Music does not know it. Rejects with YouTubeMusicError. */
  track(videoId: string): Promise<JamTrack | null>;
}

export class YouTubeMusicError extends Error {
  override name = 'YouTubeMusicError';
}

// ---------------------------------------------------------------------------
// Shapes read from youtubei.js (structural, so the mapping is testable with plain objects)
// ---------------------------------------------------------------------------

export interface ThumbnailLike {
  url: string;
  width: number;
  height: number;
}

interface NamedLike {
  name: string;
}

interface TextRunLike {
  text?: string;
}

/** A song of `music.search(q, { type: 'song' })` (MusicResponsiveListItem). */
export interface SongLike {
  id?: string;
  title?: string;
  /** Only the artists that link to a channel (youtubei.js drops the others). */
  artists?: readonly NamedLike[];
  album?: NamedLike;
  duration?: { seconds: number };
  thumbnails: readonly ThumbnailLike[];
  /** The text columns; the second one reads "Artists • Album • 3:31", every artist included. */
  flex_columns?: readonly { title?: { runs?: readonly TextRunLike[] } }[];
}

/** A video of `music.getUpNext(id)` (PlaylistPanelVideo). */
export interface PanelVideoLike {
  video_id: string;
  title: { toString(): string };
  artists?: readonly NamedLike[];
  author?: string;
  album?: NamedLike;
  duration?: { seconds: number };
  thumbnail: readonly ThumbnailLike[];
}

/** The two YouTube Music calls behind YouTubeMusic. */
export interface MusicSource {
  searchSongs(query: string): Promise<readonly SongLike[]>;
  /** The "up next" panel of `videoId` (its first video is that one); empty when unknown. */
  upNext(videoId: string): Promise<readonly PanelVideoLike[]>;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Cover art size asked for: what the app shows at most, and what YouTube Music serves. */
export const ARTWORK_SIZE = 544;
const ARTWORK_HOST = /(?:^|\.)(?:googleusercontent\.com|ytimg\.com)$/i;
/** googleusercontent sizes images from the URL: `…=w120-h120-l90-rj`. */
const GOOGLE_SIZE = /=w(\d+)-h(\d+)(?=-|$)/;

function artworkHost(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ARTWORK_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The best cover art: the largest https thumbnail from googleusercontent/ytimg no bigger than
 * ARTWORK_SIZE (else the smallest above it). A googleusercontent image smaller than that is
 * asked for at ARTWORK_SIZE instead (search only lists 60 and 120 px). Null when none qualifies.
 */
export function pickArtwork(thumbnails: readonly ThumbnailLike[]): string | null {
  const candidates = thumbnails.filter(
    (thumb) => typeof thumb.url === 'string' && artworkHost(thumb.url),
  );
  const size = (thumb: ThumbnailLike): number => Math.max(thumb.width || 0, thumb.height || 0);
  const fitting = candidates.filter((thumb) => size(thumb) <= ARTWORK_SIZE);
  const best = fitting.length
    ? fitting.reduce((a, b) => (size(b) > size(a) ? b : a))
    : candidates.reduce<ThumbnailLike | undefined>(
        (a, b) => (a === undefined || size(b) < size(a) ? b : a),
        undefined,
      );
  if (!best) return null;
  const url = new URL(best.url);
  if (/googleusercontent\.com$/i.test(url.hostname) && size(best) < ARTWORK_SIZE) {
    return best.url.replace(GOOGLE_SIZE, `=w${ARTWORK_SIZE}-h${ARTWORK_SIZE}`);
  }
  return best.url;
}

function joinArtists(artists: readonly NamedLike[] | undefined, fallback?: string): string {
  const names = (artists ?? [])
    .map((artist) => (typeof artist?.name === 'string' ? artist.name.trim() : ''))
    .filter(Boolean);
  return names.length ? names.join(', ') : (fallback?.trim() ?? '');
}

function durationMs(duration: { seconds: number } | undefined): number | null {
  const seconds = duration?.seconds;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : null;
}

function albumName(album: NamedLike | undefined): string | null {
  const name = typeof album?.name === 'string' ? album.name.trim() : '';
  return name || null;
}

/**
 * The artists as the song's second column writes them, before its first " • " ("Fruzzy • Ciber
 * Love • 2:12"): an artist without a channel has no link there, so youtubei.js leaves it out of
 * `artists`. Empty when the column has no separator (nothing tells the artists apart).
 */
export function subtitleArtists(song: SongLike): string {
  const runs = song.flex_columns?.[1]?.title?.runs ?? [];
  const parts: string[] = [];
  for (const run of runs) {
    const text = typeof run?.text === 'string' ? run.text : '';
    if (text.trim() === '•') {
      const artists = parts.join('').replace(/\s+/g, ' ').trim();
      return artists === albumName(song.album) ? '' : artists;
    }
    parts.push(text);
  }
  return '';
}

/** A search result as a JamTrack; null without a valid id, title or duration. */
export function songToTrack(song: SongLike): JamTrack | null {
  const title = typeof song.title === 'string' ? song.title.trim() : '';
  const duration = durationMs(song.duration);
  if (!song.id || !YOUTUBE_VIDEO_ID_PATTERN.test(song.id) || !title || duration === null) {
    return null;
  }
  return {
    videoId: song.id,
    title,
    artists: joinArtists(song.artists, subtitleArtists(song)),
    album: albumName(song.album),
    durationMs: duration,
    artworkUrl: pickArtwork(song.thumbnails ?? []),
  };
}

/** An up-next video as a JamTrack; null without a valid id, title or duration (a live stream). */
export function panelVideoToTrack(video: PanelVideoLike): JamTrack | null {
  const title = video.title?.toString().trim() ?? '';
  const duration = durationMs(video.duration);
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(video.video_id ?? '') || !title || duration === null) {
    return null;
  }
  return {
    videoId: video.video_id,
    title,
    artists: joinArtists(video.artists, video.author),
    album: albumName(video.album),
    durationMs: duration,
    artworkUrl: pickArtwork(video.thumbnail ?? []),
  };
}

// ---------------------------------------------------------------------------
// Track cache: search results are enqueued without asking YouTube again
// ---------------------------------------------------------------------------

/** Least-recently-used map whose entries also expire after `ttlMs`. */
export class TrackCache {
  private readonly entries = new Map<string, { track: JamTrack; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 500,
    private readonly ttlMs = 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(videoId: string): JamTrack | undefined {
    const entry = this.entries.get(videoId);
    if (!entry) return undefined;
    this.entries.delete(videoId);
    if (entry.expiresAt <= this.now()) return undefined;
    this.entries.set(videoId, entry);
    return entry.track;
  }

  set(track: JamTrack): void {
    this.entries.delete(track.videoId);
    this.entries.set(track.videoId, { track, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

export interface YouTubeMusicOptions {
  /** Defaults to youtubei.js (innertubeSource). */
  source?: MusicSource;
  /** Whole-call timeout (default 10 s). */
  timeoutMs?: number;
  cache?: TrackCache;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new YouTubeMusicError(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * A short error for the log: youtubei.js errors carry YouTube's whole response, which must never
 * end up there, so only the start of their message is kept.
 */
function upstreamError(what: string, err: unknown): YouTubeMusicError {
  if (err instanceof YouTubeMusicError) return err;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  return new YouTubeMusicError(`${what} failed: ${message}`);
}

/** YouTube Music with a track cache in front: search results and lookups are remembered. */
export function createYouTubeMusic(options: YouTubeMusicOptions = {}): YouTubeMusic {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const source = options.source ?? innertubeSource({ requestTimeoutMs: timeoutMs });
  const cache = options.cache ?? new TrackCache();
  return {
    async search(query) {
      let songs: readonly SongLike[];
      try {
        songs = await withTimeout(source.searchSongs(query), timeoutMs, 'YouTube Music search');
      } catch (err) {
        throw upstreamError('YouTube Music search', err);
      }
      const tracks: JamTrack[] = [];
      const seen = new Set<string>();
      for (const song of songs) {
        const track = songToTrack(song);
        if (!track || seen.has(track.videoId)) continue;
        seen.add(track.videoId);
        cache.set(track);
        tracks.push(track);
        if (tracks.length >= JAM_SEARCH_LIMIT) break;
      }
      return tracks;
    },

    async track(videoId) {
      const cached = cache.get(videoId);
      if (cached) return cached;
      let panel: readonly PanelVideoLike[];
      try {
        panel = await withTimeout(source.upNext(videoId), timeoutMs, 'YouTube Music up next');
      } catch (err) {
        throw upstreamError('YouTube Music up next', err);
      }
      // The panel starts with the video itself; anything else means YouTube resolved another one.
      const first = panel[0];
      const track = first && first.video_id === videoId ? panelVideoToTrack(first) : null;
      if (track) cache.set(track);
      return track;
    },
  };
}

// ---------------------------------------------------------------------------
// youtubei.js
// ---------------------------------------------------------------------------

/** What youtubei.js throws when `/next` has no queue: the id does not exist (or is private). */
const UNKNOWN_VIDEO = /probably invalid|could not find target tab/i;

interface PanelNode {
  type: string;
}

/** The PlaylistPanelVideo of a panel entry (wrappers hold it as `primary`); undefined otherwise. */
function panelVideo(node: PanelNode): PanelVideoLike | undefined {
  if (node.type === 'PlaylistPanelVideo') return node as unknown as PanelVideoLike;
  if (node.type === 'PlaylistPanelVideoWrapper') {
    const primary = (node as unknown as { primary?: PanelNode | null }).primary;
    return primary?.type === 'PlaylistPanelVideo'
      ? (primary as unknown as PanelVideoLike)
      : undefined;
  }
  return undefined;
}

export interface InnertubeSourceOptions {
  /** Per-HTTP-request timeout (default 10 s). */
  requestTimeoutMs?: number;
}

/**
 * youtubei.js, created lazily (`retrieve_player: false`: no player, nothing to decipher) and
 * reused; a call that fails on a reused session is retried once on a brand-new one.
 */
export function innertubeSource(options: InnertubeSourceOptions = {}): MusicSource {
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  let session: Promise<Innertube> | undefined;

  const timedFetch: typeof fetch = (input, init) => {
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetch(input, { ...init, signal });
  };

  function connect(): Promise<Innertube> {
    session ??= import('youtubei.js')
      .then(({ Innertube }) => Innertube.create({ retrieve_player: false, fetch: timedFetch }))
      .catch((err: unknown) => {
        session = undefined;
        throw err;
      });
    return session;
  }

  async function call<T>(run: (yt: Innertube) => Promise<T>): Promise<T> {
    const used = connect();
    try {
      return await run(await used);
    } catch {
      // A stale session (expired visitor data, a changed client version) gets one fresh retry.
      if (session === used) session = undefined;
      return run(await connect());
    }
  }

  return {
    searchSongs: (query) =>
      call(async (yt) => {
        const search = await yt.music.search(query, { type: 'song' });
        return search.songs?.contents ?? [];
      }),

    upNext: (videoId) =>
      call(async (yt) => {
        try {
          const panel = await yt.music.getUpNext(videoId, false);
          return panel.contents
            .map((node) => panelVideo(node))
            .filter((video): video is PanelVideoLike => video !== undefined);
        } catch (err) {
          if (err instanceof Error && UNKNOWN_VIDEO.test(err.message)) return [];
          throw err;
        }
      }),
  };
}
