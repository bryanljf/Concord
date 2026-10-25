/**
 * Same-origin calls to concord-api with the session cookie (`credentials: 'same-origin'`), the
 * api's error shape and the same pt-BR messages as `main/api-client.ts`. That module is typed
 * against Node's `fetch` (it streams uploads), so the web keeps its own copy of the small parts
 * it needs.
 */
import {
  JAM_MAX_DURATION_MS,
  JAM_QUEUE_MAX,
  JAM_SEARCH_MAX_LENGTH,
  type ApiErrorResponse,
} from '@concord/shared';
import { isRecord } from './parse';

export const API_TIMEOUT_MS = 10_000;

/** A ping that takes longer than this counts as lost. */
export const PING_TIMEOUT_MS = 5_000;

/** Jam search and enqueue: the api asks YouTube Music before answering. */
export const JAM_LOOKUP_TIMEOUT_MS = 15_000;

export type ApiErrorKind =
  'network' | 'timeout' | 'unauthorized' | 'rate_limited' | 'http' | 'bad_response';

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
// Error mapping
// ---------------------------------------------------------------------------

export function networkErrorMessage(host: string): string {
  return `Não foi possível conectar ao servidor ${host}. Verifique a URL e se o servidor está no ar.`;
}

export function timeoutErrorMessage(host: string): string {
  return `O servidor ${host} demorou demais para responder. Verifique a URL e se o servidor está no ar.`;
}

/** A 401 on the web means the session cookie expired or was revoked (there is no key). */
export const SESSION_EXPIRED_MESSAGE = 'Sua sessão expirou. Entre de novo com o Discord.';
export const RATE_LIMITED_MESSAGE = 'Muitas tentativas. Aguarde um minuto.';
export const BAD_RESPONSE_MESSAGE = 'Resposta inesperada do servidor.';

export function unexpectedStatusMessage(status: number): string {
  return `Erro inesperado do servidor (${status}).`;
}

export function isApiErrorResponse(value: unknown): value is ApiErrorResponse {
  return isRecord(value) && typeof value.error === 'string' && typeof value.message === 'string';
}

export function isTimeoutError(err: unknown): boolean {
  return isRecord(err) && err.name === 'TimeoutError';
}

/** Maps a non-2xx response to an `ApiClientError` (consumes the body). */
export async function errorFromResponse(res: Response): Promise<ApiClientError> {
  if (res.status === 401) return new ApiClientError('unauthorized', SESSION_EXPIRED_MESSAGE, 401);
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
  | 'previous_unavailable';

/** A concord-api from before the Jam answers its routes with a plain 404. */
export const JAM_UNSUPPORTED_SERVER_MESSAGE =
  'Este servidor ainda não tem a Jam. Peça para atualizarem o concord-api.';

/**
 * The app's own wording for each jam error, whatever the server's message says. Codes not listed
 * here (`no_downloader`: nobody with the desktop app open to download the song) keep the server's
 * message, which is pt-BR too.
 */
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
  return err;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  timeoutMs?: number;
  /** Maps a non-2xx response (default `errorFromResponse`). */
  mapError?: (res: Response) => Promise<ApiClientError>;
  /** A 401 is an expected answer here (`GET /api/me` at boot): do not report it as an expiry. */
  allowUnauthorized?: boolean;
}

export interface HttpOptions {
  /** Shown in network error messages (`location.host`). */
  host: string;
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The server answered 401 to a call that expected a session: the cookie is gone. */
  onUnauthorized?: () => void;
}

export interface Http {
  /** A JSON call; resolves with the parsed body (`bad_response` when `parse` rejects it). */
  request<T>(
    path: string,
    parse: (json: unknown) => T | null,
    body?: unknown,
    method?: HttpMethod,
    extra?: RequestOptions,
  ): Promise<T>;
  /** A call answered with 204 (whatever body comes along is dropped). */
  command(path: string, method: HttpMethod, body?: unknown, extra?: RequestOptions): Promise<void>;
  /** Round trip of `GET /api/health` in milliseconds. */
  ping(): Promise<number>;
}

export function createHttp(options: HttpOptions): Http {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? API_TIMEOUT_MS;
  const { host } = options;

  /** One call with the session cookie; resolves with the 2xx response, its body still unread. */
  async function send(
    path: string,
    method: HttpMethod,
    json: unknown,
    extra: RequestOptions,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const request: RequestInit = {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: AbortSignal.timeout(extra.timeoutMs ?? timeoutMs),
    };
    let res: Response;
    try {
      res = await fetchImpl(path, request);
    } catch (err) {
      if (isTimeoutError(err)) throw new ApiClientError('timeout', timeoutErrorMessage(host));
      throw new ApiClientError('network', networkErrorMessage(host));
    }
    if (res.status === 401 && !extra.allowUnauthorized) options.onUnauthorized?.();
    if (!res.ok) throw await (extra.mapError ?? errorFromResponse)(res);
    return res;
  }

  return {
    async request(path, parse, body, method = body === undefined ? 'GET' : 'POST', extra = {}) {
      const res = await send(path, method, body, extra);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new ApiClientError('bad_response', BAD_RESPONSE_MESSAGE, res.status);
      }
      const parsed = parse(json);
      if (parsed === null) {
        throw new ApiClientError('bad_response', BAD_RESPONSE_MESSAGE, res.status);
      }
      return parsed;
    },
    async command(path, method, body, extra = {}) {
      const res = await send(path, method, body, extra);
      await res.body?.cancel().catch(() => undefined);
    },
    async ping() {
      const started = performance.now();
      let res: Response;
      try {
        res = await fetchImpl('/api/health', {
          cache: 'no-store',
          credentials: 'same-origin',
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
  };
}
