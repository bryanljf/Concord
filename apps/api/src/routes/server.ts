import type { FastifyPluginAsync } from 'fastify';
import type { ServerInfoResponse } from '@concord/shared';
import { requireUser, type UserStore } from '../auth';

export interface ServerRoutesOptions {
  users: UserStore;
  sessionSecret: string;
  serverInfo: () => Promise<ServerInfoResponse>;
}

export const serverRoutes: FastifyPluginAsync<ServerRoutesOptions> = async (
  app,
  { users, sessionSecret, serverInfo },
) => {
  app.get(
    '/api/server',
    { preHandler: requireUser(users, sessionSecret) },
    async (): Promise<ServerInfoResponse> => serverInfo(),
  );
};
