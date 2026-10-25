import {
  JAM_MAX_DURATION_MS,
  JAM_QUEUE_MAX,
  JAM_SEARCH_MAX_LENGTH,
  JAM_UPLOAD_CONTENT_TYPE,
  JAM_UPLOAD_MAX_BYTES,
  type ApiErrorResponse,
} from '@concord/shared';

/** Every error code the Jam answers with (`ApiErrorResponse.error`). */
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
  | 'unsupported_media_type'
  | 'payload_too_large';

const STATUS: Record<JamErrorCode, number> = {
  jam_unavailable: 503,
  unknown_room: 400,
  not_in_room: 403,
  invalid_query: 400,
  search_failed: 502,
  invalid_video: 400,
  track_not_found: 404,
  too_long: 422,
  queue_full: 409,
  item_not_found: 404,
  not_requester: 403,
  already_uploaded: 409,
  invalid_audio: 422,
  stale: 409,
  unsupported_media_type: 415,
  payload_too_large: 413,
};

const MAX_MINUTES = Math.round(JAM_MAX_DURATION_MS / 60_000);
const MAX_MEGABYTES = Math.round(JAM_UPLOAD_MAX_BYTES / (1024 * 1024));

const MESSAGES: Record<JamErrorCode, string> = {
  jam_unavailable: 'A Jam não está disponível neste servidor agora.',
  unknown_room: 'Essa sala não existe.',
  not_in_room: 'Entre na sala para mexer na Jam dela.',
  invalid_query: `A busca deve ter de 1 a ${JAM_SEARCH_MAX_LENGTH} caracteres.`,
  search_failed: 'Não foi possível consultar o YouTube Music. Tente de novo.',
  invalid_video: 'Esse não é um link ou id de vídeo do YouTube válido.',
  track_not_found: 'Música não encontrada no YouTube Music.',
  too_long: `A Jam aceita músicas de até ${MAX_MINUTES} minutos.`,
  queue_full: `A fila já tem ${JAM_QUEUE_MAX} músicas. Espere algumas tocarem.`,
  item_not_found: 'Essa música não está mais na fila.',
  not_requester: 'Só quem adicionou a música pode enviar o áudio dela.',
  already_uploaded: 'O áudio dessa música já foi enviado.',
  invalid_audio: 'O áudio recebido não é válido.',
  stale: 'Essa música já não está tocando.',
  unsupported_media_type: `Envie o áudio como ${JAM_UPLOAD_CONTENT_TYPE}.`,
  payload_too_large: `O áudio passa do limite de ${MAX_MEGABYTES} MB.`,
};

/** A Jam failure the routes answer as is: HTTP status, code and a pt-BR message. */
export class JamError extends Error {
  override name = 'JamError';
  readonly statusCode: number;

  constructor(
    readonly code: JamErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
    this.statusCode = STATUS[code];
  }

  toResponse(): ApiErrorResponse {
    return { error: this.code, message: this.message };
  }
}
