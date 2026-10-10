import type { FastifyPluginAsync } from 'fastify';
import type { ApiErrorResponse, TokenRequest, TokenResponse } from '@concord/shared';
import { getUser, requireUser, type UserStore } from '../auth';
import type { ApiConfig } from '../config';
import { createRoomToken } from '../livekit';

export interface TokenRoutesOptions {
  config: Pick<ApiConfig, 'rooms' | 'livekit'>;
  users: UserStore;
}

const bodySchema = {
  type: 'object',
  required: ['room'],
  properties: {
    room: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(ip: string): boolean {
  return LOOPBACK_ADDRESSES.has(ip);
}

export const tokenRoutes: FastifyPluginAsync<TokenRoutesOptions> = async (
  app,
  { config, users },
) => {
  app.post<{ Body: TokenRequest }>(
    '/api/token',
    {
      schema: { body: bodySchema },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: requireUser(users),
    },
    async (request, reply): Promise<TokenResponse | ApiErrorResponse> => {
      const { room } = request.body;
      if (!config.rooms.includes(room)) {
        reply.code(400);
        return { error: 'unknown_room', message: `A sala "${room}" não existe.` };
      }
      const { token, expiresAt } = await createRoomToken(config.livekit, getUser(request), room);
      const { url, localUrl } = config.livekit;
      return { token, url: localUrl && isLoopback(request.ip) ? localUrl : url, expiresAt };
    },
  );
};
