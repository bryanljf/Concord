import type {
  ApiErrorResponse,
  MeResponse,
  NicknameRequest,
  RoomId,
  RoomsResponse,
  TokenPurpose,
  TokenRequest,
  TokenResponse,
  UserInfo,
} from '@concord/shared';
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
  | 'bad_response';

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
}

type HttpMethod = 'GET' | 'POST' | 'PUT';

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;

  async function request<T>(
    path: string,
    parse: (json: unknown) => T | null,
    body?: unknown,
    method: HttpMethod = body === undefined ? 'GET' : 'POST',
  ): Promise<T> {
    const base = normalizeServerUrl(options.getServerUrl());
    const key = options.getKey();
    if (key === null) throw new ApiClientError('no_key', 'Nenhuma chave de acesso configurada.');
    const host = serverHost(base);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (isTimeoutError(err)) throw new ApiClientError('timeout', timeoutErrorMessage(host));
      throw new ApiClientError('network', networkErrorMessage(host));
    }
    if (!res.ok) throw await errorFromResponse(res);

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
  };
}
