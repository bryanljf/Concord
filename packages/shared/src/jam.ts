import type { RoomId } from './index';

// ---------------------------------------------------------------------------
// Jam: a YouTube Music queue per room, played by the server's jam bot
// ---------------------------------------------------------------------------
//
// Someone searches (concord-api asks YouTube Music), adds a song to the room's queue, and their
// app downloads the audio (yt-dlp, anonymous, from their own connection: YouTube blocks the
// server's IP) and uploads it. The jam bot on the server plays the queue into the room as one
// stereo audio track; listeners use "Ouvir" and their own volume, anyone in the room can pause,
// resume, skip or remove songs.

/**
 * LiveKit identity of the jam bot. Never a user id ('@' is outside USER_ID_PATTERN) and not an
 * auxiliary identity, so its track is visible; the api keeps it out of presence.
 */
export const JAM_BOT_IDENTITY = '@jam';

/** Name the jam bot joins with. */
export const JAM_BOT_NAME = 'Jam';

/** Name of the jam's audio track (Microphone source; only the jam bot may publish one). */
export const JAM_TRACK_NAME = 'concord:music:jam';

export function isJamBotIdentity(identity: string): boolean {
  return identity === JAM_BOT_IDENTITY;
}

/** Upcoming songs per room (the one playing not included). */
export const JAM_QUEUE_MAX = 50;

/** Longest song accepted. */
export const JAM_MAX_DURATION_MS = 20 * 60 * 1000;

/** Largest audio upload accepted (a 20 min song at ~160 kbps is about 24 MB). */
export const JAM_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

/** A song still waiting for its audio after this long is dropped from the queue. */
export const JAM_UPLOAD_TIMEOUT_MS = 3 * 60 * 1000;

/** Content-Type of the audio upload (YouTube itag 251: Opus in WebM). */
export const JAM_UPLOAD_CONTENT_TYPE = 'audio/webm';

/**
 * The upload streams (chunked, sent while yt-dlp still downloads): once this much has arrived and
 * the header checks out, the song is `ready` and may start playing while the rest keeps coming
 * (~8 s of audio at 130 kbps). If the upload fails later, the song stops and leaves the queue.
 */
export const JAM_STREAM_START_BYTES = 128 * 1024;

/** Songs the server keeps (unplayed and unqueued) for at most this long. */
export const JAM_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

/** Search queries: trimmed, 1 to 100 characters. */
export const JAM_SEARCH_MAX_LENGTH = 100;

/** Results returned by a search. */
export const JAM_SEARCH_LIMIT = 20;

/** Query string that makes `GET /api/presence` also stream the jam events (old apps omit it). */
export const PRESENCE_JAM_QUERY = 'jam=1';

// ---------------------------------------------------------------------------
// Delegated downloads ("fetchers")
// ---------------------------------------------------------------------------
//
// A client that cannot run yt-dlp (the web client on a phone) still adds songs: the api asks a
// desktop app to download and upload the audio instead, silently (nothing in anyone's UI). A
// desktop app able to download opens its presence stream with `?jam=1&fetch=1`: that stream then
// also carries `jam_fetch_ping` (answered with `POST /api/jam/fetch/pong`, which is how the api
// measures each app's round trip) and `jam_fetch` (download `item` and PUT its audio exactly like
// a song you added yourself). The api ranks the candidates: apps whose person is in the song's
// room first, then everyone else, lowest round trip first (unknown last), fewest fetches in
// progress as the tie-break. If the chosen app declines, disconnects or sends nothing within
// JAM_FETCH_START_TIMEOUT_MS, the next one is asked, at most JAM_FETCH_MAX_ASSIGNMENTS times; with
// nobody left the song leaves the queue. Nobody available at enqueue time: 503 `no_downloader`.
// A desktop requester with such a stream always downloads its own songs (`upload: true`).

/** Query string that makes `GET /api/presence` also deliver fetch requests to this app. */
export const PRESENCE_FETCH_QUERY = 'fetch=1';

/** Interval between the round-trip pings sent on a fetch-enabled presence stream. */
export const JAM_FETCH_PING_MS = 30_000;

/** A fetcher that has not started uploading this long after being asked is replaced. */
export const JAM_FETCH_START_TIMEOUT_MS = 45_000;

/** How many apps are asked for one song before it is given up. */
export const JAM_FETCH_MAX_ASSIGNMENTS = 3;

/** Streamed by `GET /api/presence?jam=1&fetch=1` next to the presence and jam events. */
export type JamFetchEvent =
  { type: 'jam_fetch'; room: RoomId; item: JamItem } | { type: 'jam_fetch_ping'; nonce: string };

export type JamFetchEventType = JamFetchEvent['type'];

/** `POST /api/jam/fetch/pong` body: the nonce of the `jam_fetch_ping` being answered. */
export interface JamFetchPongRequest {
  nonce: string;
}

/**
 * `POST /api/rooms/:room/jam/items/:itemId/fetch/decline` body (assigned fetcher only): this app
 * cannot download the song (yt-dlp failed, not on Windows…); the api asks another one.
 */
export interface JamFetchDeclineRequest {
  /** Free text for the server log (no UI), at most 200 characters. */
  reason?: string;
}

/** YouTube video ids: 11 characters of the URL-safe base64 alphabet. */
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** A song, as YouTube Music describes it. */
export interface JamTrack {
  videoId: string;
  title: string;
  /** Artists joined for display: "Daft Punk, Pharrell Williams". */
  artists: string;
  album: string | null;
  durationMs: number;
  /** Cover art (https, googleusercontent.com or ytimg.com); null when there is none. */
  artworkUrl: string | null;
}

/**
 * `downloading`: waiting for the requester's app to upload the audio. `ready`: stored on the
 * server, playable. A song whose upload fails or times out leaves the queue.
 */
export type JamItemStatus = 'downloading' | 'ready';

/** One entry of a room's queue (the same song may be queued twice: `id` tells them apart). */
export interface JamItem {
  id: string;
  track: JamTrack;
  /** User id of who added it. */
  requestedBy: string;
  /** Server clock, Unix epoch in milliseconds. */
  addedAt: number;
  status: JamItemStatus;
}

/** The song playing (or paused) in a room. */
export interface JamNowPlaying {
  item: JamItem;
  /** Position at `at`; while playing it advances in real time (`jamPositionAt`). */
  positionMs: number;
  /** Server clock, Unix epoch in milliseconds. */
  at: number;
  paused: boolean;
  /** User id of who paused it; null while playing. */
  pausedBy: string | null;
}

export interface JamState {
  room: RoomId;
  current: JamNowPlaying | null;
  /** Upcoming songs in play order. */
  queue: JamItem[];
  /**
   * Songs already played in this jam (ended or skipped), most recent first, at most
   * `JAM_HISTORY_MAX`. "Música anterior" plays `history[0]`; the app shows that button only when
   * this is not empty. The history keeps the session alive while the bot lingers after playback
   * ends. Optional for servers from before it (= []).
   */
  history?: JamItem[];
}

/** Songs remembered per room for "Música anterior". */
export const JAM_HISTORY_MAX = 20;

export interface JamSnapshot {
  /** False when the server runs without a jam bot: the app hides the Jam. */
  available: boolean;
  /** Rooms with something playing, queued, or retained in the current session history. */
  rooms: Record<RoomId, JamState>;
  /** Server clock when sent, so the app can correct its own clock for the progress bar. */
  serverTime: number;
}

/** Streamed by `GET /api/presence?jam=1` next to the presence events. */
export type JamEvent =
  | { type: 'jam_snapshot'; data: JamSnapshot }
  | {
      /** A room's whole jam, replaced. An empty one (including no history) ended. */
      type: 'jam_updated';
      state: JamState;
      serverTime: number;
    };

export type JamEventType = JamEvent['type'];

export function isJamEmpty(state: JamState): boolean {
  return state.current === null && state.queue.length === 0 && (state.history?.length ?? 0) === 0;
}

/** Applies a jam event to a snapshot, returning a new snapshot (pure). */
export function applyJamEvent(snapshot: JamSnapshot, event: JamEvent): JamSnapshot {
  if (event.type === 'jam_snapshot') return event.data;
  const rooms = { ...snapshot.rooms };
  if (isJamEmpty(event.state)) delete rooms[event.state.room];
  else rooms[event.state.room] = event.state;
  return { available: snapshot.available, rooms, serverTime: event.serverTime };
}

/** Where the current song is at `serverNow`: frozen while paused, within 0..duration. */
export function jamPositionAt(nowPlaying: JamNowPlaying, serverNow: number): number {
  const elapsed = nowPlaying.paused ? 0 : Math.max(0, serverNow - nowPlaying.at);
  const position = nowPlaying.positionMs + elapsed;
  const duration = nowPlaying.item.track.durationMs;
  return Math.max(0, duration > 0 ? Math.min(duration, position) : position);
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

/**
 * The video id in what someone typed or pasted: a bare id or a YouTube / YouTube Music link
 * (`watch?v=`, `youtu.be/<id>`, `/shorts/<id>`, `/embed/<id>`, `/live/<id>`). Null otherwise.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const value = input.trim();
  if (YOUTUBE_VIDEO_ID_PATTERN.test(value)) return value;
  // [scheme://]host[/path][?query][#hash]; only http(s) or no scheme at all.
  const match = /^(?:(https?):\/\/)?([^/?#\s]+)(\/[^?#\s]*)?(?:\?([^#\s]*))?(?:#\S*)?$/i.exec(
    value,
  );
  if (!match) return null;
  const host = (match[2] ?? '').toLowerCase();
  const path = match[3] ?? '/';
  const query = match[4] ?? '';
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const candidate = host.endsWith('youtu.be')
    ? path.split('/')[1]
    : path === '/watch'
      ? /(?:^|&)v=([^&]*)/.exec(query)?.[1]
      : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(path)?.[1];
  return candidate && YOUTUBE_VIDEO_ID_PATTERN.test(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// HTTP API DTOs (all need the session; mutations need you to be in the room)
// ---------------------------------------------------------------------------
//
// GET    /api/jam/search?q=<query>                         → JamSearchResponse
// GET    /api/jam/recent                                    → JamRecentResponse
// GET    /api/jam                                          → JamSnapshot
// POST   /api/rooms/:room/jam/queue           JamEnqueueRequest → JamEnqueueResponse
// PUT    /api/rooms/:room/jam/items/:itemId/audio  (audio/webm body, may be chunked/streamed;
//        requester or the fetcher the api assigned) → 204 once the whole body arrived (the song
//        may already be playing)
// POST   /api/jam/fetch/pong                  JamFetchPongRequest                  → 204
// POST   /api/rooms/:room/jam/items/:itemId/fetch/decline  JamFetchDeclineRequest  → 204
//        (assigned fetcher only; 404 item_not_found when the song is gone or reassigned)
// DELETE /api/rooms/:room/jam/items/:itemId   (the current one = skip)              → 204
// POST   /api/rooms/:room/jam/skip            JamSkipRequest                        → 204
// POST   /api/rooms/:room/jam/seek            JamSeekRequest                        → 204
// POST   /api/rooms/:room/jam/previous        JamPreviousRequest                    → 204
// POST   /api/rooms/:room/jam/pause                                                 → 204
// POST   /api/rooms/:room/jam/resume                                                → 204
//
// Error codes (ApiErrorResponse.error): jam_unavailable (503), unknown_room (400),
// not_in_room (403), invalid_query (400), search_failed (502), invalid_video (400),
// track_not_found (404), too_long (422), queue_full (409), item_not_found (404),
// not_requester (403), already_uploaded (409), invalid_audio (422), stale (409),
// no_downloader (503: the requester cannot download and no desktop app is connected to do it).

export interface JamSearchResponse {
  results: JamTrack[];
  /** Video ids among `results` whose audio the server already has: adding them is instant. */
  cached: string[];
}

/** A song whose audio the server still has (its cache keeps songs used in the last 3 h). */
export interface JamRecentTrack extends JamTrack {
  /** Server clock: when it last started playing (only songs that really played are listed). */
  usedAt: number;
}

/**
 * "Recentes": the songs that really played (any room) and are still in the server's audio cache,
 * most recently played first.
 * Adding one is instant (no download). Empty list: the app hides the button.
 */
export interface JamRecentResponse {
  tracks: JamRecentTrack[];
}

export interface JamEnqueueRequest {
  videoId: string;
}

export interface JamEnqueueResponse {
  item: JamItem;
  /**
   * True: this app must download the audio and PUT it; false: the server already has it, or
   * another app was asked to fetch it (the item then stays `downloading` until it arrives).
   */
  upload: boolean;
}

/** Skips only if `itemId` is still the one playing, so two quick skips skip one song. */
export interface JamSkipRequest {
  itemId: string;
}

/**
 * Moves the song playing to `positionMs` (clamped to the song), for everyone, only if `itemId` is
 * still the one playing (409 `stale` otherwise). A paused song stays paused at the new position.
 * Past what was uploaded so far, playback waits there until the upload catches up.
 */
export interface JamSeekRequest {
  itemId: string;
  positionMs: number;
}

/**
 * Plays the previous song (`history[0]`) from the start, for everyone; the song playing goes back
 * to the front of the queue (so "Pular" returns to it). `itemId` is the song playing as the app
 * saw it (null when nothing plays): 409 `stale` if that changed, so two quick presses go back one
 * song. Errors: 409 `no_previous` (empty history), 410 `previous_unavailable` (its audio left the
 * server's cache; the song is dropped from the history).
 */
export interface JamPreviousRequest {
  itemId: string | null;
}
