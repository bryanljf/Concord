import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ApiConfig } from '../config';
import { issueSessionToken, type UserStore } from '../auth';

const AUTHORIZE = 'https://discord.com/oauth2/authorize';
const TOKEN = 'https://discord.com/api/oauth2/token';
const IDENTIFY = 'https://discord.com/api/users/@me';
const COOKIE = 'concord_oauth_state';
const states = new Map<string, number>();

/** Drops expired OAuth states so abandoned logins do not accumulate in memory. */
function purgeExpiredStates(now: number): void {
  for (const [state, expires] of states) {
    if (expires < now) states.delete(state);
  }
}

export function discordAuthRoutes(
  app: FastifyInstance,
  options: { config: ApiConfig; users: UserStore },
): void {
  const { config, users } = options;
  app.get(
    '/api/auth/discord/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (_request, reply) => {
      const state = randomBytes(32).toString('base64url');
      purgeExpiredStates(Date.now());
      states.set(state, Date.now() + 10 * 60_000);
      const url = new URL(AUTHORIZE);
      url.searchParams.set('client_id', config.auth.discordClientId);
      url.searchParams.set('redirect_uri', config.auth.discordRedirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', config.auth.discordScopes);
      url.searchParams.set('state', state);
      return reply
        .header(
          'set-cookie',
          `${COOKIE}=${state}; HttpOnly; SameSite=Lax; Path=/;${config.auth.discordRedirectUri.startsWith('https://') ? ' Secure' : ''}`,
        )
        .redirect(url.toString());
    },
  );

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/auth/discord/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code, state, error } = request.query;
      const cookie = request.headers.cookie?.match(/(?:^|;\s*)concord_oauth_state=([^;]+)/)?.[1];
      const expires = state ? states.get(state) : undefined;
      if (
        error ||
        !code ||
        !state ||
        !cookie ||
        cookie !== state ||
        !expires ||
        expires < Date.now()
      ) {
        return reply.code(400).send({
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
        return reply
          .code(502)
          .send({ error: 'oauth_exchange_failed', message: 'Não foi possível concluir o login.' });
      const token = (await tokenResponse.json()) as {
        access_token?: unknown;
        token_type?: unknown;
      };
      if (typeof token.access_token !== 'string' || token.token_type !== 'Bearer') {
        return reply
          .code(502)
          .send({ error: 'oauth_exchange_failed', message: 'Resposta inválida do Discord.' });
      }
      const identifyResponse = await fetch(IDENTIFY, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      if (!identifyResponse.ok)
        return reply.code(502).send({
          error: 'oauth_identify_failed',
          message: 'Não foi possível identificar a conta Discord.',
        });
      const discordUser = (await identifyResponse.json()) as { id?: unknown };
      if (typeof discordUser.id !== 'string')
        return reply
          .code(502)
          .send({ error: 'oauth_identify_failed', message: 'Resposta inválida do Discord.' });
      const user = users.findByDiscordUserId(discordUser.id);
      if (!user)
        return reply
          .code(403)
          .send({ error: 'not_allowlisted', message: 'Esta conta não está autorizada.' });
      return reply.send({
        token: issueSessionToken(user, config.auth.sessionSecret, config.auth.sessionTtlSeconds),
        user: { id: user.id, displayName: user.displayName, admin: user.admin === true },
      });
    },
  );
}
