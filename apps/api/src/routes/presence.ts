import type { FastifyPluginAsync } from 'fastify';
import { SSE_HEARTBEAT_MS, type PresenceEvent } from '@concord/shared';
import { requireUser, type UserStore } from '../auth';
import type { PresenceStore } from '../presence-store';

export interface PresenceRoutesOptions {
  users: UserStore;
  presence: PresenceStore;
  /** Heartbeat interval; defaults to SSE_HEARTBEAT_MS. */
  heartbeatMs?: number;
  sessionSecret: string;
}

export const SSE_HEARTBEAT = ': ping\n\n';

export function formatSseEvent(event: PresenceEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * `GET /api/presence`: Server-Sent Events. Sends the full snapshot first, then every presence
 * event as it happens, plus a comment heartbeat so idle connections are not dropped by proxies.
 */
export const presenceRoutes: FastifyPluginAsync<PresenceRoutesOptions> = async (
  app,
  { users, presence, heartbeatMs = SSE_HEARTBEAT_MS, sessionSecret },
) => {
  app.get('/api/presence', { preHandler: requireUser(users, sessionSecret) }, (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    request.raw.socket?.setNoDelay(true);
    // Keep headers set by hooks before the hijack (CORS, in particular).
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) res.setHeader(name, value);
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: PresenceEvent): void => {
      res.write(formatSseEvent(event));
    };
    send({ type: 'snapshot', data: presence.snapshot() });
    const unsubscribe = presence.subscribe(send);
    const heartbeat = setInterval(() => res.write(SSE_HEARTBEAT), heartbeatMs);

    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
};
