import type { FastifyPluginAsync } from 'fastify';
import type { ApiErrorResponse, MeResponse, NicknameRequest } from '@concord/shared';
import { getUser, requireUser, toUserInfo, type UserStore } from '../auth';
import { normalizeNickname, type ProfileStore } from '../profiles';

export interface MeRoutesOptions {
  users: UserStore;
  profiles: ProfileStore;
  sessionSecret: string;
}

/** Generous raw limit: the real rule (1–32 code points after trimming) is checked afterwards. */
const NICKNAME_RAW_MAX_LENGTH = 256;

const nicknameBodySchema = {
  type: 'object',
  required: ['nickname'],
  properties: {
    nickname: { type: ['string', 'null'], maxLength: NICKNAME_RAW_MAX_LENGTH },
  },
} as const;

export const meRoutes: FastifyPluginAsync<MeRoutesOptions> = async (
  app,
  { users, profiles, sessionSecret },
) => {
  const authenticate = requireUser(users, sessionSecret);

  app.get('/api/me', { preHandler: authenticate }, async (request): Promise<MeResponse> => {
    const user = getUser(request);
    return { user: toUserInfo(user, profiles.get(user.id)) };
  });

  /** `PUT /api/me/nickname`: sets the name shown to everyone; null or '' clears it. */
  app.put<{ Body: NicknameRequest }>(
    '/api/me/nickname',
    {
      schema: { body: nicknameBodySchema },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      preHandler: authenticate,
    },
    async (request, reply): Promise<MeResponse | ApiErrorResponse> => {
      const user = getUser(request);
      const result = normalizeNickname(request.body.nickname);
      if (!result.ok) {
        reply.code(400);
        return { error: 'invalid_nickname', message: result.message };
      }
      const profile = await profiles.setNickname(user.id, result.nickname);
      return { user: toUserInfo(user, profile) };
    },
  );
};
