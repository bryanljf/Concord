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
}

export interface JamSnapshot {
  /** False when the server runs without a jam bot: the app hides the Jam. */
  available: boolean;
  /** Only rooms with something playing or queued. */
  rooms: Record<RoomId, JamState>;
  /** Server clock when sent, so the app can correct its own clock for the progress bar. */
  serverTime: number;
}

/** Streamed by `GET /api/presence?jam=1` next to the presence events. */
export type JamEvent =
  | { type: 'jam_snapshot'; data: JamSnapshot }
  | {
      /** A room's whole jam, replaced. An empty one (nothing playing or queued) ended. */
      type: 'jam_updated';
      state: JamState;
      serverTime: number;
    };

export type JamEventType = JamEvent['type'];

export function isJamEmpty(state: JamState): boolean {
  return state.current === null && state.queue.length === 0;
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
// GET    /api/jam                                          → JamSnapshot
// POST   /api/rooms/:room/jam/queue           JamEnqueueRequest → JamEnqueueResponse
// PUT    /api/rooms/:room/jam/items/:itemId/audio  (audio/webm body, may be chunked/streamed;
//        requester only) → 204 once the whole body arrived (the song may already be playing)
// DELETE /api/rooms/:room/jam/items/:itemId   (the current one = skip)              → 204
// POST   /api/rooms/:room/jam/skip            JamSkipRequest                        → 204
// POST   /api/rooms/:room/jam/pause                                                 → 204
// POST   /api/rooms/:room/jam/resume                                                → 204
//
// Error codes (ApiErrorResponse.error): jam_unavailable (503), unknown_room (400),
// not_in_room (403), invalid_query (400), search_failed (502), invalid_video (400),
// track_not_found (404), too_long (422), queue_full (409), item_not_found (404),
// not_requester (403), already_uploaded (409), invalid_audio (422), stale (409).

export interface JamSearchResponse {
  results: JamTrack[];
  /** Video ids among `results` whose audio the server already has: adding them is instant. */
  cached: string[];
}

export interface JamEnqueueRequest {
  videoId: string;
}

export interface JamEnqueueResponse {
  item: JamItem;
  /** True: this app must download the audio and PUT it; false: the server already has it. */
  upload: boolean;
}

/** Skips only if `itemId` is still the one playing, so two quick skips skip one song. */
export interface JamSkipRequest {
  itemId: string;
}
