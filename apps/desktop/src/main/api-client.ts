import {
  JAM_MAX_DURATION_MS,
  JAM_QUEUE_MAX,
  JAM_SEARCH_LIMIT,
  JAM_SEARCH_MAX_LENGTH,
  JAM_UPLOAD_CONTENT_TYPE,
  YOUTUBE_VIDEO_ID_PATTERN,
  type ApiErrorResponse,
  type JamEnqueueRequest,
  type JamEnqueueResponse,
  type JamPreviousRequest,
  type JamRecentResponse,
  type JamRecentTrack,
  type JamSearchResponse,
  type JamSeekRequest,
  type JamSkipRequest,
  type JamTrack,
  type MeResponse,
  type NicknameRequest,
  type RoomId,
  type RoomsResponse,
  type ServerInfoResponse,
  type TokenPurpose,
  type TokenRequest,
  type TokenResponse,
  type UserInfo,
} from '@concord/shared';
import { parseJamItem, parseJamRecentTrack, parseJamTrack } from './jam-events';
import { parseAvatarUrl, parseProfileName } from './profile';

export const API_TIMEOUT_MS = 10_000;

export type ApiErrorKind =
  | 'invalid_url'
  | 'no_key'
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'rate_limited'
  | 'http'
  | 'bad_response'
  /** The caller aborted the request (a jam upload on logout or quit). */
  | 'cancelled';

/** Error whose `message` is pt-BR and safe to show in the UI. */
export class ApiClientError extends Error {
  override readonly name = 'ApiClientError';
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    /** HTTP status, when the server answered. */
    readonly status?: number,
    /** `ApiErrorResponse.error` code, when the server sent one. */
    readonly code?: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/**
 * Normalises a user-typed server URL to `scheme://host[:port]`: trims, requires http/https,
 * drops credentials, path, query, hash and trailing slashes. Throws `ApiClientError` (pt-BR).
 */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new ApiClientError('invalid_url', 'Informe a URL do servidor.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new ApiClientError(
      'invalid_url',
      'A URL do servidor deve começar com http:// ou https://.',
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ApiClientError(
      'invalid_url',
      'URL do servidor inválida. Use algo como https://concord.exemplo.com ou http://192.168.0.10:3000.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiClientError(
      'invalid_url',
      'A URL do servidor deve começar com http:// ou https://.',
    );
  }
  preferHttps(url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Public domains are served over HTTPS (Caddy redirects plain HTTP), so a stored or typed
 * `http://domain` without an explicit port is upgraded. IPs, localhost, *.local and explicit
 * ports (self-hosting on a PC, e.g. http://1.2.3.4:3000) keep plain HTTP.
 */
export function preferHttps(url: URL): void {
  if (url.protocol !== 'http:' || url.port !== '') return;
  const host = url.hostname;
  const local =
    host === 'localhost' ||
    host.endsWith('.local') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    host.startsWith('[');
  if (!local) url.protocol = 'https:';
}

export function serverHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export function networkErrorMessage(host: string): string {
  return `Não foi possível conectar ao servidor ${host}. Verifique a URL e se o servidor está no ar.`;
}

export function timeoutErrorMessage(host: string): string {
  return `O servidor ${host} demorou demais para responder. Verifique a URL e se o servidor está no ar.`;
}

export const UNAUTHORIZED_MESSAGE = 'Chave de acesso inválida.';
export const RATE_LIMITED_MESSAGE = 'Muitas tentativas. Aguarde um minuto.';
export const BAD_RESPONSE_MESSAGE = 'Resposta inesperada do servidor.';

export function unexpectedStatusMessage(status: number): string {
  return `Erro inesperado do servidor (${status}).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return isRecord(value) && typeof value.error === 'string' && typeof value.message === 'string';
}

export function isTimeoutError(err: unknown): boolean {
  return isRecord(err) && err.name === 'TimeoutError';
}

/** Maps a non-2xx response to an `ApiClientError` (consumes the body). */
export async function errorFromResponse(res: Response): Promise<ApiClientError> {
  if (res.status === 401) return new ApiClientError('unauthorized', UNAUTHORIZED_MESSAGE, 401);
  if (res.status === 429) return new ApiClientError('rate_limited', RATE_LIMITED_MESSAGE, 429);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (isApiErrorResponse(body)) {
    return new ApiClientError('http', body.message, res.status, body.error);
  }
  return new ApiClientError('http', unexpectedStatusMessage(res.status), res.status);
}

export const CANCELLED_MESSAGE = 'Envio cancelado.';

/** Error codes of the jam routes (`ApiErrorResponse.error`), see `@concord/shared` jam.ts. */
export type JamErrorCode =
  | 'jam_unavailable'
  | 'unknown_room'
  | 'not_in_room'
  | 'invalid_query'
  | 'search_failed'
  | 'invalid_video'
  | 'track_not_found'
  | 'too_long'
  | 'queue_full'
  | 'item_not_found'
  | 'not_requester'
  | 'already_uploaded'
  | 'invalid_audio'
  | 'stale'
  | 'no_previous'
  | 'previous_unavailable'
  // Upload-only, from the api's own error list (not in the shared contract).
  | 'unsupported_media_type'
  | 'payload_too_large';

/** A concord-api from before the Jam answers its routes with a plain 404. */
export const JAM_UNSUPPORTED_SERVER_MESSAGE =
  'Este servidor ainda não tem a Jam. Peça para atualizarem o concord-api.';
export const JAM_AUDIO_TOO_LARGE_MESSAGE = 'O áudio dessa música é grande demais para a Jam.';

/** The app's own wording for each jam error, whatever the server's message says. */
export const JAM_ERROR_MESSAGES: Readonly<Record<JamErrorCode, string>> = {
  jam_unavailable: 'A Jam está fora do ar no servidor agora. Tente de novo daqui a pouco.',
  unknown_room: 'Sala desconhecida.',
  not_in_room: 'Entre na sala para mexer na Jam.',
  invalid_query: `A busca deve ter de 1 a ${JAM_SEARCH_MAX_LENGTH} caracteres.`,
  search_failed: 'O YouTube Music não respondeu à busca. Tente de novo.',
  invalid_video: 'Esse link ou vídeo do YouTube não é válido.',
  track_not_found: 'Essa música não foi encontrada no YouTube Music.',
  too_long: `Essa música é longa demais para a Jam (máximo de ${JAM_MAX_DURATION_MS / 60_000} minutos).`,
  queue_full: `A fila da Jam está cheia (${JAM_QUEUE_MAX} músicas). Espere algumas tocarem.`,
  item_not_found: 'Essa música não está mais na fila.',
  not_requester: 'Só quem adicionou a música pode enviar o áudio dela.',
  already_uploaded: 'O áudio dessa música já foi enviado.',
  invalid_audio: 'O servidor recusou o áudio baixado do YouTube.',
  stale: 'Essa música já tinha sido pulada.',
  no_previous: 'Não há música anterior nesta Jam.',
  previous_unavailable: 'A música anterior não está mais disponível.',
  unsupported_media_type: 'O servidor recusou o formato do áudio baixado do YouTube.',
  payload_too_large: JAM_AUDIO_TOO_LARGE_MESSAGE,
};

function isJamErrorCode(code: string | undefined): code is JamErrorCode {
  return code !== undefined && Object.hasOwn(JAM_ERROR_MESSAGES, code);
}

/** `errorFromResponse` with the jam's messages (status and code are kept for the callers). */
export async function jamErrorFromResponse(res: Response): Promise<ApiClientError> {
  const err = await errorFromResponse(res);
  if (err.kind !== 'http') return err;
  if (isJamErrorCode(err.code)) {
    return new ApiClientError('http', JAM_ERROR_MESSAGES[err.code], err.status, err.code);
  }
  if (err.status === 404 && (err.code === undefined || err.code === 'not_found')) {
    return new ApiClientError('http', JAM_UNSUPPORTED_SERVER_MESSAGE, 404, err.code);
  }
  if (err.status === 413) {
    return new ApiClientError('http', JAM_AUDIO_TOO_LARGE_MESSAGE, 413, err.code);
  }
  return err;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Validates a `UserInfo` from the server (or `settings.json`). The profile fields are optional
 * for older servers: missing or malformed values become null; unknown fields are dropped.
 */
export function parseUserInfo(value: unknown): UserInfo | null {
  if (!isRecord(value)) return null;
  const { id, displayName, admin } = value;
  if (typeof id !== 'string' || typeof displayName !== 'string') return null;
  return {
    id,
    displayName,
    admin: admin === true,
    avatarUrl: parseAvatarUrl(value.avatarUrl),
    discordName: parseProfileName(value.discordName),
    nickname: parseProfileName(value.nickname),
  };
}

function parseMe(value: unknown): UserInfo | null {
  return isRecord(value) ? parseUserInfo((value as Partial<MeResponse>).user) : null;
}

function parseRooms(value: unknown): RoomId[] | null {
  if (!isRecord(value)) return null;
  const rooms = (value as Partial<RoomsResponse>).rooms;
  if (!Array.isArray(rooms) || !rooms.every((room) => typeof room === 'string')) return null;
  return rooms;
}

function parseToken(value: unknown): TokenResponse | null {
  if (!isRecord(value)) return null;
  const { token, url, expiresAt } = value as Partial<TokenResponse>;
  if (typeof token !== 'string' || typeof url !== 'string' || typeof expiresAt !== 'number') {
    return null;
  }
  return { token, url, expiresAt };
}

export function parseServerInfo(value: unknown): ServerInfoResponse | null {
  if (!isRecord(value)) return null;
  const { name, region, provider } = value as Partial<ServerInfoResponse>;
  if (typeof name !== 'string' || name === '') return null;
  return {
    name,
    region: typeof region === 'string' && region !== '' ? region : null,
    provider: provider === 'oracle' ? 'oracle' : null,
  };
}

/** A ping that takes longer than this counts as lost. */
export const PING_TIMEOUT_MS = 5_000;

/** Jam search and enqueue: the api asks YouTube Music before answering. */
export const JAM_LOOKUP_TIMEOUT_MS = 15_000;
/**
 * Sending a song's audio (a few MB, up to `JAM_UPLOAD_MAX_BYTES`) on a home upload link, streamed
 * while yt-dlp still downloads it (which gives up after 3 minutes).
 */
export const JAM_UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

function parseJamSearch(value: unknown): JamSearchResponse | null {
  if (!isRecord(value)) return null;
  const { results, cached } = value as Partial<JamSearchResponse>;
  if (!Array.isArray(results)) return null;
  // One odd result (a video YouTube Music describes strangely) must not sink the whole search.
  const tracks: JamTrack[] = [];
  for (const entry of results.slice(0, JAM_SEARCH_LIMIT)) {
    const track = parseJamTrack(entry);
    if (track) tracks.push(track);
  }
  // Servers from before the prefetch round do not say which songs they have.
  const known = Array.isArray(cached)
    ? cached.filter(
        (videoId): videoId is string =>
          typeof videoId === 'string' && YOUTUBE_VIDEO_ID_PATTERN.test(videoId),
      )
    : [];
  return { results: tracks, cached: known };
}

/** Longest "Recentes" list kept (the server's 3 h cache never holds anywhere near this many). */
export const JAM_RECENT_MAX = 500;

function parseJamRecent(value: unknown): JamRecentTrack[] | null {
  if (!isRecord(value)) return null;
  const { tracks } = value as Partial<JamRecentResponse>;
  if (!Array.isArray(tracks)) return null;
  // Like the search: one odd entry is skipped, not the whole list.
  const recent: JamRecentTrack[] = [];
  for (const entry of tracks.slice(0, JAM_RECENT_MAX)) {
    const track = parseJamRecentTrack(entry);
    if (track) recent.push(track);
  }
  return recent;
}

function parseJamEnqueue(value: unknown): JamEnqueueResponse | null {
  if (!isRecord(value)) return null;
  const { upload } = value as Partial<JamEnqueueResponse>;
  const item = parseJamItem(value.item);
  if (!item || typeof upload !== 'boolean') return null;
  return { item, upload };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ApiClientOptions {
  getServerUrl(): string;
  getKey(): string | null;
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ApiClient {
  /** `GET /api/me` */
  me(): Promise<UserInfo>;
  /** `GET /api/rooms` */
  rooms(): Promise<RoomId[]>;
  /** `POST /api/token`; `purpose: 'popout'` asks for the hidden, subscribe-only identity. */
  token(room: RoomId, purpose?: TokenPurpose): Promise<TokenResponse>;
  /** `PUT /api/me/nickname`; null clears the nickname (back to the Discord name). */
  setNickname(nickname: string | null): Promise<UserInfo>;
  /** `GET /api/server`: instance name and region. */
  server(): Promise<ServerInfoResponse>;
  /** Round trip of `GET /api/health` in milliseconds (the connection is kept alive between pings). */
  ping(): Promise<number>;

  // Jam: every error is an `ApiClientError` with the jam's own pt-BR messages (`code` kept).
  /**
   * `GET /api/jam/search?q=`: YouTube Music songs (malformed results are skipped) and which of
   * them the server already has (none with older servers).
   */
  jamSearch(query: string): Promise<JamSearchResponse>;
  /**
   * `GET /api/jam/recent`: the songs the server still has, most recently used first (malformed
   * entries skipped, at most `JAM_RECENT_MAX`).
   */
  jamRecent(): Promise<JamRecentTrack[]>;
  /** `POST /api/rooms/:room/jam/queue` */
  jamEnqueue(room: RoomId, videoId: string): Promise<JamEnqueueResponse>;
  /**
   * `PUT /api/rooms/:room/jam/items/:itemId/audio`: the WebM/Opus bytes (requester only), whole
   * or as a stream sent chunked while it is read. Resolves on the server's 204.
   */
  jamUpload(
    room: RoomId,
    itemId: string,
    audio: Uint8Array | ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** `DELETE /api/rooms/:room/jam/items/:itemId` (the one playing: skips it). */
  jamRemove(room: RoomId, itemId: string): Promise<void>;
  /** `POST /api/rooms/:room/jam/skip`; code `stale` when `itemId` is no longer the one playing. */
  jamSkip(room: RoomId, itemId: string): Promise<void>;
  /** `POST /api/rooms/:room/jam/seek`; code `stale` when `itemId` is no longer the one playing. */
  jamSeek(room: RoomId, itemId: string, positionMs: number): Promise<void>;
  /**
   * `POST /api/rooms/:room/jam/previous`, `itemId` being the song playing (null: none); code
   * `stale` when that changed, `no_previous` / `previous_unavailable` when there is none to play.
   */
  jamPrevious(room: RoomId, itemId: string | null): Promise<void>;
  /** `POST /api/rooms/:room/jam/pause` */
  jamPause(room: RoomId): Promise<void>;
  /** `POST /api/rooms/:room/jam/resume` */
  jamResume(room: RoomId): Promise<void>;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface SendOptions {
  method: HttpMethod;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as is (the jam audio upload); a stream goes out chunked as it is read. */
  raw?: { body: Uint8Array | ReadableStream<Uint8Array>; contentType: string };
  timeoutMs?: number;
  /** Cancels the request (rejects with kind `cancelled`). */
  signal?: AbortSignal;
  /** Maps a non-2xx response (default `errorFromResponse`). */
  mapError?: (res: Response) => Promise<ApiClientError>;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;

  /** One authenticated call; resolves with the 2xx response, its body still unread. */
  async function send(path: string, init: SendOptions): Promise<Response> {
    const base = normalizeServerUrl(options.getServerUrl());
    const key = options.getKey();
    if (key === null) throw new ApiClientError('no_key', 'Nenhuma chave de acesso configurada.');
    const host = serverHost(base);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    };
    let body: string | Uint8Array | ReadableStream<Uint8Array> | undefined;
    if (init.raw) {
      headers['Content-Type'] = init.raw.contentType;
      body = init.raw.body;
    } else if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    }
    const timeout = AbortSignal.timeout(init.timeoutMs ?? timeoutMs);
    const signal = init.signal ? AbortSignal.any([timeout, init.signal]) : timeout;
    const request: RequestInit = { method: init.method, headers, body, signal };
    // Node's fetch sends a stream body as it is read (chunked) only when told so.
    if (body instanceof ReadableStream) request.duplex = 'half';

    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, request);
    } catch (err) {
      if (init.signal?.aborted) throw new ApiClientError('cancelled', CANCELLED_MESSAGE);
      if (isTimeoutError(err)) throw new ApiClientError('timeout', timeoutErrorMessage(host));
      throw new ApiClientError('network', networkErrorMessage(host));
    }
    if (!res.ok) throw await (init.mapError ?? errorFromResponse)(res);
    return res;
  }

  async function request<T>(
    path: string,
    parse: (json: unknown) => T | null,
    body?: unknown,
    method: HttpMethod = body === undefined ? 'GET' : 'POST',
    extra: Pick<SendOptions, 'timeoutMs' | 'mapError'> = {},
  ): Promise<T> {
    const res = await send(path, { ...extra, method, json: body });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiClientError('bad_response', BAD_RESPONSE_MESSAGE, res.status);
    }
    const parsed = parse(json);
    if (parsed === null) throw new ApiClientError('bad_response', BAD_RESPONSE_MESSAGE, res.status);
    return parsed;
  }

  /** A jam call answered with 204 (whatever body comes along is dropped). */
  async function jamCommand(
    path: string,
    init: Pick<SendOptions, 'method' | 'json' | 'raw' | 'timeoutMs' | 'signal'>,
  ): Promise<void> {
    const res = await send(path, { ...init, mapError: jamErrorFromResponse });
    await res.body?.cancel().catch(() => undefined);
  }

  const jamPath = (room: RoomId, rest: string): string =>
    `/api/rooms/${encodeURIComponent(room)}/jam/${rest}`;
  const jamItemPath = (room: RoomId, itemId: string, rest = ''): string =>
    jamPath(room, `items/${encodeURIComponent(itemId)}${rest}`);
  // Search and enqueue wait for the api to ask YouTube Music.
  const jamLookup = { timeoutMs: JAM_LOOKUP_TIMEOUT_MS, mapError: jamErrorFromResponse };

  return {
    me: () => request('/api/me', parseMe),
    rooms: () => request('/api/rooms', parseRooms),
    token: (room, purpose) => {
      // `purpose` is omitted from the JSON when undefined (`JSON.stringify` drops it).
      const body: TokenRequest = { room, purpose };
      return request('/api/token', parseToken, body);
    },
    setNickname: (nickname) => {
      const body: NicknameRequest = { nickname };
      return request('/api/me/nickname', parseMe, body, 'PUT');
    },
    server: () => request('/api/server', parseServerInfo),
    ping: async () => {
      const base = normalizeServerUrl(options.getServerUrl());
      const host = serverHost(base);
      const started = performance.now();
      let res: Response;
      try {
        res = await fetchImpl(`${base}/api/health`, {
          cache: 'no-store',
          signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        });
        await res.arrayBuffer();
      } catch (err) {
        if (isTimeoutError(err)) throw new ApiClientError('timeout', timeoutErrorMessage(host));
        throw new ApiClientError('network', networkErrorMessage(host));
      }
      if (!res.ok) throw new ApiClientError('bad_response', unexpectedStatusMessage(res.status));
      return Math.max(0, Math.round(performance.now() - started));
    },
    jamSearch: (query) =>
      request(
        `/api/jam/search?q=${encodeURIComponent(query)}`,
        parseJamSearch,
        undefined,
        'GET',
        jamLookup,
      ),
    jamRecent: () =>
      request('/api/jam/recent', parseJamRecent, undefined, 'GET', {
        mapError: jamErrorFromResponse,
      }),
    jamEnqueue: (room, videoId) => {
      const body: JamEnqueueRequest = { videoId };
      return request(jamPath(room, 'queue'), parseJamEnqueue, body, 'POST', jamLookup);
    },
    jamUpload: (room, itemId, audio, signal) =>
      jamCommand(jamItemPath(room, itemId, '/audio'), {
        method: 'PUT',
        raw: { body: audio, contentType: JAM_UPLOAD_CONTENT_TYPE },
        timeoutMs: JAM_UPLOAD_REQUEST_TIMEOUT_MS,
        signal,
      }),
    jamRemove: (room, itemId) => jamCommand(jamItemPath(room, itemId), { method: 'DELETE' }),
    jamSkip: (room, itemId) => {
      const body: JamSkipRequest = { itemId };
      return jamCommand(jamPath(room, 'skip'), { method: 'POST', json: body });
    },
    jamSeek: (room, itemId, positionMs) => {
      const body: JamSeekRequest = { itemId, positionMs };
      return jamCommand(jamPath(room, 'seek'), { method: 'POST', json: body });
    },
    jamPrevious: (room, itemId) => {
      const body: JamPreviousRequest = { itemId };
      return jamCommand(jamPath(room, 'previous'), { method: 'POST', json: body });
    },
    jamPause: (room) => jamCommand(jamPath(room, 'pause'), { method: 'POST' }),
    jamResume: (room) => jamCommand(jamPath(room, 'resume'), { method: 'POST' }),
  };
}
