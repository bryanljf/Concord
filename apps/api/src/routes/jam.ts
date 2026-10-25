import type { Readable } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import {
  JAM_UPLOAD_CONTENT_TYPE,
  type JamEnqueueResponse,
  type JamFetchDeclineRequest,
  type JamFetchPongRequest,
  type JamPreviousRequest,
  type JamRecentResponse,
  type JamSearchResponse,
  type JamSeekRequest,
  type JamSnapshot,
  type RoomId,
} from '@concord/shared';
import { getUser, requireUser, type UserStore } from '../auth';
import { JamError } from '../jam/errors';
import type { JamService } from '../jam/service';

export interface JamRoutesOptions {
  users: UserStore;
  sessionSecret: string;
  jam: JamService;
}

interface RoomParams {
  room: RoomId;
}

interface ItemParams extends RoomParams {
  itemId: string;
}

/** `type/subtype` of a Content-Type header, lowercased, without parameters. */
function mediaType(header: string | undefined): string | undefined {
  return header?.split(';')[0]?.trim().toLowerCase() || undefined;
}

function isStream(body: unknown): body is Readable {
  return typeof (body as Readable | undefined)?.pipe === 'function';
}

/** The string field `name` of a JSON body, or undefined. */
function stringField(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

const PER_MINUTE = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute' } });

/** Item ids are ours (UUIDs): anything longer is not one. */
const ITEM_ID_MAX_LENGTH = 64;

const seekBodySchema = {
  type: 'object',
  required: ['itemId', 'positionMs'],
  properties: {
    itemId: { type: 'string', maxLength: ITEM_ID_MAX_LENGTH },
    positionMs: { type: 'integer', minimum: 0 },
  },
} as const;

const previousBodySchema = {
  type: 'object',
  required: ['itemId'],
  properties: {
    itemId: { type: ['string', 'null'], maxLength: ITEM_ID_MAX_LENGTH },
  },
} as const;

/** Nonces are ours (16 characters of base64url): anything longer is not one. */
const pongBodySchema = {
  type: 'object',
  required: ['nonce'],
  properties: {
    nonce: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const;

/** A JSON body is required (`{}` without a reason). */
const declineBodySchema = {
  type: 'object',
  properties: {
    reason: { type: 'string', maxLength: 200 },
  },
} as const;

/**
 * The Jam (a YouTube Music queue per room, routes listed in `@concord/shared` jam.ts). Every
 * route needs the session; mutations also need the caller in that room, except the audio upload
 * (only its requester, or the app the api asked to download it, may send it, from anywhere: the
 * app keeps sending after a room change) and the fetch routes (any app with a fetch stream).
 */
export const jamRoutes: FastifyPluginAsync<JamRoutesOptions> = async (
  app,
  { users, sessionSecret, jam },
) => {
  const authenticate = requireUser(users, sessionSecret);

  // Jam errors answer with their own code and pt-BR message; anything else goes to the app's.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof JamError) return reply.code(error.statusCode).send(error.toResponse());
    throw error;
  });

  app.get<{ Querystring: { q?: unknown } }>(
    '/api/jam/search',
    { preHandler: authenticate, config: PER_MINUTE(30) },
    async (request): Promise<JamSearchResponse> => {
      const { q } = request.query;
      return jam.search(typeof q === 'string' ? q : '');
    },
  );

  app.get(
    '/api/jam/recent',
    { preHandler: authenticate, config: PER_MINUTE(30) },
    async (): Promise<JamRecentResponse> => jam.recent(),
  );

  app.get('/api/jam', { preHandler: authenticate }, async (): Promise<JamSnapshot> =>
    jam.snapshot(),
  );

  app.post<{ Params: RoomParams; Body: unknown }>(
    '/api/rooms/:room/jam/queue',
    { preHandler: authenticate, config: PER_MINUTE(30) },
    async (request): Promise<JamEnqueueResponse> => {
      const videoId = stringField(request.body, 'videoId');
      if (videoId === undefined) throw new JamError('invalid_video');
      const user = getUser(request);
      // An app with a fetch stream downloads its own songs; anyone else (the web) is fetched for.
      const canDownload = jam.fetchers.hasUser(user.id);
      return jam.enqueue(user.id, request.params.room, videoId.trim(), canDownload);
    },
  );

  app.post<{ Body: JamFetchPongRequest }>(
    '/api/jam/fetch/pong',
    { schema: { body: pongBodySchema }, preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      // An unknown or stale nonce is ignored: nothing to tell the app.
      jam.fetchers.pong(request.body.nonce, getUser(request).id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: ItemParams; Body: JamFetchDeclineRequest }>(
    '/api/rooms/:room/jam/items/:itemId/fetch/decline',
    { schema: { body: declineBodySchema }, preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      const { room, itemId } = request.params;
      jam.declineFetch(getUser(request).id, room, itemId, request.body.reason);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: ItemParams }>(
    '/api/rooms/:room/jam/items/:itemId',
    { preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      const { room, itemId } = request.params;
      await jam.remove(getUser(request).id, room, itemId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: RoomParams; Body: unknown }>(
    '/api/rooms/:room/jam/skip',
    { preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      const itemId = stringField(request.body, 'itemId');
      if (!itemId) throw new JamError('stale');
      await jam.skip(getUser(request).id, request.params.room, itemId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: RoomParams; Body: JamSeekRequest }>(
    '/api/rooms/:room/jam/seek',
    { schema: { body: seekBodySchema }, preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      const { itemId, positionMs } = request.body;
      await jam.seek(getUser(request).id, request.params.room, itemId, positionMs);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: RoomParams; Body: JamPreviousRequest }>(
    '/api/rooms/:room/jam/previous',
    { schema: { body: previousBodySchema }, preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      await jam.previous(getUser(request).id, request.params.room, request.body.itemId);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: RoomParams }>(
    '/api/rooms/:room/jam/pause',
    { preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      await jam.pause(getUser(request).id, request.params.room);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: RoomParams }>(
    '/api/rooms/:room/jam/resume',
    { preHandler: authenticate, config: PER_MINUTE(60) },
    async (request, reply) => {
      await jam.resume(getUser(request).id, request.params.room);
      return reply.code(204).send();
    },
  );

  // The audio upload, in its own scope: only here does `audio/webm` reach the handler, as the
  // raw stream (written to disk as it arrives, never buffered in memory; it may be chunked and
  // slow, and its song may start playing long before it ends). Answered once the body ended.
  app.register(async (scope) => {
    scope.addContentTypeParser(JAM_UPLOAD_CONTENT_TYPE, (_request, payload, done) => {
      done(null, payload);
    });

    scope.put<{ Params: ItemParams; Body: unknown }>(
      '/api/rooms/:room/jam/items/:itemId/audio',
      {
        preHandler: authenticate,
        // Documents the limit: a streamed body is counted by the service as it is written.
        bodyLimit: jam.uploadMaxBytes,
        config: PER_MINUTE(20),
      },
      async (request, reply) => {
        const { room, itemId } = request.params;
        const { body, raw } = request;
        const declared = Number(request.headers['content-length']);
        const length = Number.isFinite(declared) ? declared : undefined;
        try {
          if (mediaType(request.headers['content-type']) !== JAM_UPLOAD_CONTENT_TYPE) {
            throw new JamError('unsupported_media_type');
          }
          if (!isStream(body)) throw new JamError('invalid_audio');
          await jam.upload(getUser(request).id, room, itemId, body, length);
        } catch (err) {
          // A body never read is discarded by Node, so the client still gets this answer (it
          // needs it: already_uploaded means done, item_not_found means gone). One read halfway,
          // or announced over the limit, is not worth waiting for: close the connection instead.
          const halfRead = raw.readableDidRead && !raw.readableEnded;
          if (halfRead || (length ?? 0) > jam.uploadMaxBytes) reply.header('connection', 'close');
          throw err;
        }
        return reply.code(204).send();
      },
    );
  });
};
