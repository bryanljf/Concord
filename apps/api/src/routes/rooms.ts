import type { FastifyPluginAsync } from 'fastify';
import type { RoomId, RoomsResponse } from '@telao/shared';
import { requireUser, type UserStore } from '../auth';

export interface RoomsRoutesOptions {
  users: UserStore;
  rooms: readonly RoomId[];
}

export const roomsRoutes: FastifyPluginAsync<RoomsRoutesOptions> = async (
  app,
  { users, rooms },
) => {
  app.get('/api/rooms', { preHandler: requireUser(users) }, async (): Promise<RoomsResponse> => ({
    rooms: [...rooms],
  }));
};
