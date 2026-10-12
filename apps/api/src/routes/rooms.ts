import type { FastifyPluginAsync } from 'fastify';
import type { RoomId, RoomsResponse } from '@concord/shared';
import { requireUser, type UserStore } from '../auth';

export interface RoomsRoutesOptions {
  users: UserStore;
  rooms: readonly RoomId[];
  sessionSecret: string;
}

export const roomsRoutes: FastifyPluginAsync<RoomsRoutesOptions> = async (
  app,
  { users, rooms, sessionSecret },
) => {
  app.get(
    '/api/rooms',
    { preHandler: requireUser(users, sessionSecret) },
    async (): Promise<RoomsResponse> => ({
      rooms: [...rooms],
    }),
  );
};
