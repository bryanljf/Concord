import type { FastifyPluginAsync } from 'fastify';
import type { HealthResponse } from '@concord/shared';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  // Hit every 30 s by the Docker healthcheck and often by every app (its ping): routine traffic
  // that would fill the log, so its request/response lines are not logged (warnings still are).
  app.get('/api/health', { logLevel: 'warn' }, async (): Promise<HealthResponse> => ({ ok: true }));
};
