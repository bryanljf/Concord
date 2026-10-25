import type { FastifyPluginAsync } from 'fastify';
import {
  PRESENCE_FETCH_QUERY,
  PRESENCE_JAM_QUERY,
  SSE_HEARTBEAT_MS,
  type JamEvent,
  type JamFetchEvent,
  type PresenceEvent,
} from '@concord/shared';
import { getUser, requireUser, type UserStore } from '../auth';
import type { JamFetchers } from '../jam/fetchers';
import type { JamFeed } from '../jam/service';
import type { PresenceStore } from '../presence-store';

export interface PresenceRoutesOptions {
  users: UserStore;
  presence: PresenceStore;
  /** The jam events, streamed too when the app asks for them (`?jam=1`). */
  jam?: JamFeed;
  /** Where apps able to download for others register (`?jam=1&fetch=1`). */
  fetchers?: JamFetchers;
  /** Heartbeat interval; defaults to SSE_HEARTBEAT_MS. */
  heartbeatMs?: number;
  sessionSecret: string;
}

export const SSE_HEARTBEAT = ': ping\n\n';

const [JAM_QUERY_KEY = 'jam', JAM_QUERY_VALUE = '1'] = PRESENCE_JAM_QUERY.split('=');
const [FETCH_QUERY_KEY = 'fetch', FETCH_QUERY_VALUE = '1'] = PRESENCE_FETCH_QUERY.split('=');

export function formatSseEvent(event: PresenceEvent | JamEvent | JamFetchEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * `GET /api/presence`: Server-Sent Events. Sends the full snapshot first, then every presence
 * event as it happens, plus a comment heartbeat so idle connections are not dropped by proxies.
 * With `?jam=1` the jam rides the same stream: a `jam_snapshot` right after the presence
 * snapshot, then every `jam_updated`. With `?jam=1&fetch=1` the app also offers to download songs
 * for clients that cannot: it gets `jam_fetch_ping` (answered with `POST /api/jam/fetch/pong`)
 * and `jam_fetch` requests. Apps that do not ask get exactly the presence events.
 */
export const presenceRoutes: FastifyPluginAsync<PresenceRoutesOptions> = async (
  app,
  { users, presence, jam, fetchers, heartbeatMs = SSE_HEARTBEAT_MS, sessionSecret },
) => {
  app.get<{ Querystring: Record<string, unknown> }>(
    '/api/presence',
    { preHandler: requireUser(users, sessionSecret) },
    (request, reply) => {
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

      const send = (event: PresenceEvent | JamEvent | JamFetchEvent): void => {
        res.write(formatSseEvent(event));
      };
      send({ type: 'snapshot', data: presence.snapshot() });
      const unsubscribe = presence.subscribe(send);
      const withJam = jam !== undefined && request.query[JAM_QUERY_KEY] === JAM_QUERY_VALUE;
      let unsubscribeJam: (() => void) | undefined;
      let unregisterFetcher: (() => void) | undefined;
      if (withJam) {
        send({ type: 'jam_snapshot', data: jam.snapshot() });
        unsubscribeJam = jam.subscribe(send);
        if (fetchers && request.query[FETCH_QUERY_KEY] === FETCH_QUERY_VALUE) {
          unregisterFetcher = fetchers.register({ userId: getUser(request).id, send });
        }
      }
      const heartbeat = setInterval(() => res.write(SSE_HEARTBEAT), heartbeatMs);

      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeJam?.();
        unregisterFetcher?.();
      });
    },
  );
};
