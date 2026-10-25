import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { WebhookReceiver } from 'livekit-server-sdk';
import type { ApiErrorResponse, ServerInfoResponse } from '@concord/shared';
import type { UserStore } from './auth';
import type { ApiConfig } from './config';
import { createJamService, type JamService } from './jam/service';
import type { YouTubeMusic } from './jam/youtube';
import { createWebhookReceiver } from './livekit';
import { cachedServerInfo } from './server-info';
import type { PresenceStore } from './presence-store';
import type { ProfileStore } from './profiles';
import { healthRoutes } from './routes/health';
import { jamRoutes } from './routes/jam';
import { livekitWebhookRoutes } from './routes/livekit-webhook';
import { meRoutes } from './routes/me';
import { presenceRoutes } from './routes/presence';
import { roomsRoutes } from './routes/rooms';
import { serverRoutes } from './routes/server';
import { tokenRoutes } from './routes/token';
import { discordAuthRoutes } from './routes/discord-auth';

export interface BuildAppOptions {
  config: ApiConfig;
  users: UserStore;
  presence: PresenceStore;
  /**
   * Discord names, avatars and nicknames. Its changes are forwarded to `presence.refreshUser`;
   * `presence` should be built with a resolver over the same store (createProfileResolver).
   */
  profiles: ProfileStore;
  logger?: FastifyServerOptions['logger'];
  /** SSE heartbeat interval (defaults to SSE_HEARTBEAT_MS); overridable for tests. */
  heartbeatMs?: number;
  /** Verifier for LiveKit webhooks; defaults to one built from the config. */
  webhookReceiver?: Pick<WebhookReceiver, 'receive'>;
  /** Instance name and region for `GET /api/server`; defaults to detecting them once. */
  serverInfo?: () => Promise<ServerInfoResponse>;
  /**
   * The Jam, started and stopped by its owner (index.ts). Defaults to one built from the config
   * (with `youtube` and `now` below), never started: no persistence, no bot events.
   */
  jam?: JamService;
  /** YouTube Music client for the default Jam; defaults to youtubei.js. */
  youtube?: YouTubeMusic;
  /** Clock for the default Jam. */
  now?: () => number;
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
  const { config, users, presence, profiles } = options;
  // One hop (Caddy): the client IP is the last X-Forwarded-For entry; a spoofed header is ignored.
  const trustProxy: FastifyServerOptions['trustProxy'] = config.trustProxy
    ? (_address: string, hop: number) => hop === 0
    : false;
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy,
    // Lets close() finish promptly even while SSE connections are open.
    forceCloseConnections: true,
  });

  app.register(cors, {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
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

  // Name/avatar changes reach everyone watching presence (participant_updated).
  const stopProfileForwarding = profiles.onChange((userId) => presence.refreshUser(userId));
  app.addHook('onClose', async () => stopProfileForwarding());

  const jam =
    options.jam ??
    createJamService({
      config,
      presence,
      log: app.log,
      youtube: options.youtube,
      now: options.now,
    });

  app.register(healthRoutes);
  // Registered as a plugin so @fastify/rate-limit (loaded above) sees these routes.
  app.register(async (instance) => discordAuthRoutes(instance, { config, users, profiles }));
  app.register(meRoutes, { users, profiles, sessionSecret: config.auth.sessionSecret });
  app.register(roomsRoutes, {
    users,
    rooms: config.rooms,
    sessionSecret: config.auth.sessionSecret,
  });
  app.register(serverRoutes, {
    users,
    sessionSecret: config.auth.sessionSecret,
    serverInfo: options.serverInfo ?? cachedServerInfo(config.server),
  });
  app.register(tokenRoutes, {
    config,
    users,
    profiles,
    sessionSecret: config.auth.sessionSecret,
  });
  app.register(presenceRoutes, {
    users,
    presence,
    jam,
    // Desktop apps offering to download for the web register on their presence stream.
    fetchers: jam.fetchers,
    heartbeatMs: options.heartbeatMs,
    sessionSecret: config.auth.sessionSecret,
  });
  app.register(jamRoutes, { users, sessionSecret: config.auth.sessionSecret, jam });
  app.register(livekitWebhookRoutes, {
    presence,
    receiver: options.webhookReceiver ?? createWebhookReceiver(config.livekit),
  });

  return app;
}
