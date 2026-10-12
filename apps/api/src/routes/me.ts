import type { FastifyPluginAsync } from 'fastify';
import type { MeResponse } from '@concord/shared';
import { getUser, requireUser, toUserInfo, type UserStore } from '../auth';

export interface MeRoutesOptions {
  users: UserStore;
  sessionSecret: string;
}

export const meRoutes: FastifyPluginAsync<MeRoutesOptions> = async (
  app,
  { users, sessionSecret },
) => {
  app.get(
    '/api/me',
    { preHandler: requireUser(users, sessionSecret) },
    async (request): Promise<MeResponse> => ({
      user: toUserInfo(getUser(request)),
    }),
  );
};
