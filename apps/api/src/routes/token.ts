import type { FastifyPluginAsync } from 'fastify';
import type { ApiErrorResponse, TokenPurpose, TokenRequest, TokenResponse } from '@concord/shared';
import { getUser, requireUser, type UserStore } from '../auth';
import type { ApiConfig } from '../config';
import { createRoomToken } from '../livekit';
import { resolveDisplayName, type ProfileStore } from '../profiles';

export interface TokenRoutesOptions {
  config: Pick<ApiConfig, 'rooms' | 'livekit'>;
  users: UserStore;
  profiles: ProfileStore;
  sessionSecret: string;
}

const TOKEN_PURPOSES = ['main', 'popout', 'pip', 'web'] as const satisfies readonly TokenPurpose[];

const bodySchema = {
  type: 'object',
  required: ['room'],
  properties: {
    room: { type: 'string', minLength: 1, maxLength: 64 },
    purpose: { type: 'string', enum: TOKEN_PURPOSES },
  },
} as const;

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopback(ip: string): boolean {
  return LOOPBACK_ADDRESSES.has(ip);
}

export const tokenRoutes: FastifyPluginAsync<TokenRoutesOptions> = async (
  app,
  { config, users, profiles, sessionSecret },
) => {
  app.post<{ Body: TokenRequest }>(
    '/api/token',
    {
      schema: { body: bodySchema },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: requireUser(users, sessionSecret),
    },
    async (request, reply): Promise<TokenResponse | ApiErrorResponse> => {
      const { room, purpose = 'main' } = request.body;
      if (!config.rooms.includes(room)) {
        reply.code(400);
        return { error: 'unknown_room', message: `A sala "${room}" não existe.` };
      }
      const user = getUser(request);
      const { token, expiresAt } = await createRoomToken(
        config.livekit,
        user,
        room,
        purpose,
        resolveDisplayName(user, profiles.get(user.id)),
      );
      const { url, localUrl } = config.livekit;
      return { token, url: localUrl && isLoopback(request.ip) ? localUrl : url, expiresAt };
    },
  );
};
