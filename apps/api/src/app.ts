import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { WebhookReceiver } from 'livekit-server-sdk';
import type { ApiErrorResponse } from '@concord/shared';
import type { UserStore } from './auth';
import type { ApiConfig } from './config';
import { createWebhookReceiver } from './livekit';
import type { PresenceStore } from './presence-store';
import { healthRoutes } from './routes/health';
import { livekitWebhookRoutes } from './routes/livekit-webhook';
import { meRoutes } from './routes/me';
import { presenceRoutes } from './routes/presence';
import { roomsRoutes } from './routes/rooms';
import { tokenRoutes } from './routes/token';

export interface BuildAppOptions {
  config: ApiConfig;
  users: UserStore;
  presence: PresenceStore;
  logger?: FastifyServerOptions['logger'];
  /** SSE heartbeat interval (defaults to SSE_HEARTBEAT_MS); overridable for tests. */
  heartbeatMs?: number;
  /** Verifier for LiveKit webhooks; defaults to one built from the config. */
  webhookReceiver?: Pick<WebhookReceiver, 'receive'>;
}

const NOT_FOUND: ApiErrorResponse = { error: 'not_found', message: 'Rota não encontrada.' };
const INTERNAL_ERROR: ApiErrorResponse = {
  error: 'internal_error',
  message: 'Erro interno do servidor.',
};
const CLIENT_ERRORS: Record<number, ApiErrorResponse> = {
  400: { error: 'invalid_request', message: 'Requisição inválida.' },
  404: NOT_FOUND,
  413: { error: 'payload_too_large', message: 'Corpo da requisição grande demais.' },
  415: { error: 'unsupported_media_type', message: 'Tipo de conteúdo não suportado.' },
  429: {
    error: 'rate_limited',
    message: 'Muitas requisições. Aguarde um instante e tente de novo.',
  },
};

function toClientError(error: FastifyError, statusCode: number): ApiErrorResponse {
  if (error.validation) {
    return { error: 'invalid_request', message: `Requisição inválida: ${error.message}.` };
  }
  return CLIENT_ERRORS[statusCode] ?? { error: 'request_error', message: 'Requisição inválida.' };
}

/** Builds the HTTP app without listening; fully exercisable through `app.inject()`. */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const { config, users, presence } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: config.trustProxy,
    // Lets close() finish promptly even while SSE connections are open.
    forceCloseConnections: true,
  });

  app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  app.register(rateLimit, { global: false });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND));
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(500).send(INTERNAL_ERROR);
    }
    return reply.code(statusCode).send(toClientError(error, statusCode));
  });

  app.register(healthRoutes);
  app.register(meRoutes, { users });
  app.register(roomsRoutes, { users, rooms: config.rooms });
  app.register(tokenRoutes, { config, users });
  app.register(presenceRoutes, { users, presence, heartbeatMs: options.heartbeatMs });
  app.register(livekitWebhookRoutes, {
    presence,
    receiver: options.webhookReceiver ?? createWebhookReceiver(config.livekit),
  });

  return app;
}
