import type { FastifyPluginAsync } from 'fastify';
import type { MeResponse } from '@telao/shared';
import { getUser, requireUser, toUserInfo, type UserStore } from '../auth';

export interface MeRoutesOptions {
  users: UserStore;
}

export const meRoutes: FastifyPluginAsync<MeRoutesOptions> = async (app, { users }) => {
  app.get('/api/me', { preHandler: requireUser(users) }, async (request): Promise<MeResponse> => ({
    user: toUserInfo(getUser(request)),
  }));
};
