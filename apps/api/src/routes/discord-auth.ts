import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { LOGIN_ERROR_QUERY, type ApiErrorResponse, type SessionRequest } from '@concord/shared';
import type { ApiConfig } from '../config';
import {
  clearedSessionCookie,
  issueSessionToken,
  readCookie,
  sessionCookie,
  toUserInfo,
  type User,
  type UserStore,
} from '../auth';
import { discordProfileData, parseDiscordUser, type ProfileStore } from '../profiles';

const AUTHORIZE = 'https://discord.com/oauth2/authorize';
const TOKEN = 'https://discord.com/api/oauth2/token';
const IDENTIFY = 'https://discord.com/api/users/@me';
const COOKIE = 'concord_oauth_state';

/**
 * Who started the login: the desktop app gets the session token in a JSON body; the web app
 * (`?client=web`) gets it as the session cookie and is sent back to `/`.
 */
type LoginClient = 'desktop' | 'web';

interface PendingLogin {
  expires: number;
  client: LoginClient;
}

const states = new Map<string, PendingLogin>();

/** Drops expired OAuth states so abandoned logins do not accumulate in memory. */
function purgeExpiredStates(now: number): void {
  for (const [state, { expires }] of states) {
    if (expires < now) states.delete(state);
  }
}

const sessionBodySchema = {
  type: 'object',
  required: ['key'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 256 },
  },
} as const;

export function discordAuthRoutes(
  app: FastifyInstance,
  options: { config: ApiConfig; users: UserStore; profiles: ProfileStore },
): void {
  const { config, users, profiles } = options;
  // Same rule for every cookie: only mark them Secure when the site is served over https.
  const secure = config.auth.discordRedirectUri.startsWith('https://');
  const { sessionSecret, sessionTtlSeconds } = config.auth;
  const webSessionCookie = (user: User): string =>
    sessionCookie(
      issueSessionToken(user, sessionSecret, sessionTtlSeconds),
      sessionTtlSeconds,
      secure,
    );

  app.get<{ Querystring: { client?: string } }>(
    '/api/auth/discord/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const state = randomBytes(32).toString('base64url');
      purgeExpiredStates(Date.now());
      const client: LoginClient = request.query.client === 'web' ? 'web' : 'desktop';
      states.set(state, { expires: Date.now() + 10 * 60_000, client });
      const url = new URL(AUTHORIZE);
      url.searchParams.set('client_id', config.auth.discordClientId);
      url.searchParams.set('redirect_uri', config.auth.discordRedirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', config.auth.discordScopes);
      url.searchParams.set('state', state);
      return reply
        .header(
          'set-cookie',
          `${COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/;${secure ? ' Secure' : ''}`,
        )
        .redirect(url.toString());
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/discord/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code, state, error } = request.query;
      const cookie = readCookie(request.headers.cookie, COOKIE);
      const pending = state ? states.get(state) : undefined;
      // An unknown state (api restarted, forged) cannot tell the client: it gets the JSON answer.
      const web = pending?.client === 'web';
      /** JSON for the desktop app; the web app lands on `/?login_error=<code>` instead. */
      const fail = (status: number, body: ApiErrorResponse) =>
        web
          ? reply.redirect(`/?${LOGIN_ERROR_QUERY}=${body.error}`)
          : reply.code(status).send(body);
      if (
        error ||
        !code ||
        !state ||
        !cookie ||
        cookie !== state ||
        !pending ||
        pending.expires < Date.now()
      ) {
        return fail(400, {
          error: 'invalid_oauth_state',
          message: 'Fluxo de autenticação inválido ou expirado.',
        });
      }
      states.delete(state);
      const body = new URLSearchParams({
        client_id: config.auth.discordClientId,
        client_secret: config.auth.discordClientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: config.auth.discordRedirectUri,
      });
      const tokenResponse = await fetch(TOKEN, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!tokenResponse.ok)
        return fail(502, {
          error: 'oauth_exchange_failed',
          message: 'Não foi possível concluir o login.',
        });
      const token = (await tokenResponse.json()) as {
        access_token?: unknown;
        token_type?: unknown;
      };
      if (typeof token.access_token !== 'string' || token.token_type !== 'Bearer') {
        return fail(502, {
          error: 'oauth_exchange_failed',
          message: 'Resposta inválida do Discord.',
        });
      }
      const identifyResponse = await fetch(IDENTIFY, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      if (!identifyResponse.ok)
        return fail(502, {
          error: 'oauth_identify_failed',
          message: 'Não foi possível identificar a conta Discord.',
        });
      const discordUser = parseDiscordUser(await identifyResponse.json());
      if (!discordUser)
        return fail(502, {
          error: 'oauth_identify_failed',
          message: 'Resposta inválida do Discord.',
        });
      const user = users.findByDiscordUserId(discordUser.id);
      if (!user)
        return fail(403, { error: 'not_allowlisted', message: 'Esta conta não está autorizada.' });
      // Name and avatar exactly as on Discord; a failed write must not block the login.
      try {
        await profiles.setDiscord(user.id, discordProfileData(discordUser));
      } catch (err) {
        request.log.error({ err, userId: user.id }, 'could not persist the Discord profile');
      }
      if (web) return reply.header('set-cookie', webSessionCookie(user)).redirect('/');
      return reply.send({
        token: issueSessionToken(user, sessionSecret, sessionTtlSeconds),
        user: toUserInfo(user, profiles.get(user.id)),
      });
    },
  );

  /**
   * `POST /api/auth/session`: signs the web client in with an access key from users.json (the
   * same key the desktop uses as Bearer). Only tests and local development go this way: the web
   * UI offers nothing but Discord.
   */
  app.post<{ Body: SessionRequest }>(
    '/api/auth/session',
    {
      schema: { body: sessionBodySchema },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = users.findByKey(request.body.key);
      if (!user) {
        const body: ApiErrorResponse = {
          error: 'unauthorized',
          message: 'Chave de acesso inválida.',
        };
        return reply.code(401).send(body);
      }
      return reply.code(204).header('set-cookie', webSessionCookie(user)).send();
    },
  );

  /** `POST /api/auth/logout`: forgets the web session (the cookie is the whole session). */
  app.post('/api/auth/logout', async (_request, reply) =>
    reply.code(204).header('set-cookie', clearedSessionCookie(secure)).send(),
  );
}
