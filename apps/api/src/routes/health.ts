import type { FastifyPluginAsync } from 'fastify';
import type { HealthResponse } from '@concord/shared';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/health', async (): Promise<HealthResponse> => ({ ok: true }));
};
