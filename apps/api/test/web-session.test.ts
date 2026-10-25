import type { FastifyInstance } from 'fastify';
import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  type ApiErrorResponse,
  type MeResponse,
  type TokenResponse,
} from '@concord/shared';
import {
  clearedSessionCookie,
  issueSessionToken,
  readCookie,
  sessionCookie,
  userFromSessionToken,
  UserStore,
} from '../src/auth';
import { ALICE, API_KEY, API_SECRET, BOB, bearer, testApp, testConfig } from './helpers';

const HOST = 'concord.test';

/** Signs in through `POST /api/auth/session`; returns the `Cookie` header the browser would send. */
async function signIn(app: FastifyInstance, key = ALICE.key): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/session', payload: { key } });
  expect(res.statusCode).toBe(204);
  return (res.headers['set-cookie'] as string).split(';')[0] as string;
}

function putNickname(app: FastifyInstance, headers: Record<string, string>, nickname = 'Lice') {
  return app.inject({ method: 'PUT', url: '/api/me/nickname', headers, payload: { nickname } });
}

describe('readCookie', () => {
  it('finds the named cookie and leaves the value as is', () => {
    expect(readCookie('a=1; concord_session=tok.sig; b=2', SESSION_COOKIE_NAME)).toBe('tok.sig');
    expect(readCookie('concord_session=tok.sig', SESSION_COOKIE_NAME)).toBe('tok.sig');
    expect(readCookie('concord_session = tok.sig ;', SESSION_COOKIE_NAME)).toBe('tok.sig');
  });

  it('ignores other names, empty values and missing headers', () => {
    expect(
      readCookie('xconcord_session=1; concord_sessionx=2', SESSION_COOKIE_NAME),
    ).toBeUndefined();
    expect(readCookie('concord_session=; a=1', SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readCookie('garbage', SESSION_COOKIE_NAME)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE_NAME)).toBeUndefined();
  });
});

describe('session cookie values', () => {
  it('are HttpOnly, Lax, site-wide, bounded by the session TTL and Secure only over https', () => {
    expect(sessionCookie('tok.sig', 3600, false)).toBe(
      'concord_session=tok.sig; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600',
    );
    expect(sessionCookie('tok.sig', 3600, true)).toBe(
      'concord_session=tok.sig; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600; Secure',
    );
    expect(clearedSessionCookie(false)).toBe(
      'concord_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    );
    expect(clearedSessionCookie(true)).toMatch(/Max-Age=0; Secure$/);
  });
});

describe('POST /api/auth/session', () => {
  it('answers 204 with a session cookie for a valid access key', async () => {
    const { app, config, users } = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/session',
      payload: { key: ALICE.key },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const setCookie = res.headers['set-cookie'] as string;
    expect(setCookie).toMatch(
      /^concord_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/,
    );
    const token = readCookie(setCookie.split(';')[0], SESSION_COOKIE_NAME) as string;
    expect(userFromSessionToken(token, users, config.auth.sessionSecret)).toEqual(ALICE);
    await app.close();
  });

  it('marks the cookie Secure when the site is served over https', async () => {
    const config = testConfig();
    config.auth = {
      ...config.auth,
      discordRedirectUri: 'https://concord.example/api/auth/discord/callback',
    };
    const { app } = testApp({ config });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/session',
      payload: { key: ALICE.key },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toMatch(/; Secure$/);
    await app.close();
  });

  it('answers 401 without a cookie for an unknown key', async () => {
    const { app } = testApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/session',
      payload: { key: 'nope-nope-nope-nope-nope' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.json<ApiErrorResponse>()).toEqual({
      error: 'unauthorized',
      message: expect.any(String),
    });
    await app.close();
  });

  it.each<[string, object]>([
    ['a missing key', {}],
    ['an empty key', { key: '' }],
    ['an object key', { key: { nested: true } }],
  ])('rejects %s with invalid_request', async (_label, payload) => {
    const { app } = testApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/session', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorResponse>().error).toBe('invalid_request');
    await app.close();
  });

  it('rate limits sign-ins to 10 per minute per IP', async () => {
    const { app } = testApp();
    const attempt = (remoteAddress: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/session',
        payload: { key: 'wrong-wrong-wrong-wrong' },
        remoteAddress,
      });
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt('203.0.113.1')).statusCode, `attempt ${i + 1}`).toBe(401);
    }
    const limited = await attempt('203.0.113.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ApiErrorResponse>().error).toBe('rate_limited');
    expect((await attempt('203.0.113.2')).statusCode).toBe(401);
    await app.close();
  });
});

describe('cookie-authenticated requests', () => {
  it('read routes accept the cookie alone', async () => {
    const { app } = testApp();
    const cookie = await signIn(app);
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json<MeResponse>().user).toMatchObject({ id: 'alice', displayName: 'Alice' });
    const rooms = await app.inject({ method: 'GET', url: '/api/rooms', headers: { cookie } });
    expect(rooms.statusCode).toBe(200);
    expect(rooms.json()).toEqual({ rooms: ['geral', 'jogos'] });
    await app.close();
  });

  it('the cookie rides among other cookies', async () => {
    const { app } = testApp();
    const cookie = await signIn(app);
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `theme=dark; ${cookie}; other=1` },
    });
    expect(me.statusCode).toBe(200);
    await app.close();
  });

  it('state-changing routes refuse a cookie-only request that is not same-origin (csrf)', async () => {
    const { app, profiles } = testApp();
    const cookie = await signIn(app);
    const res = await putNickname(app, { cookie, host: HOST });
    expect(res.statusCode).toBe(403);
    expect(res.json<ApiErrorResponse>()).toEqual({
      error: 'csrf',
      message: 'Requisição recusada.',
    });
    expect(profiles.get('alice')).toBeUndefined();

    const crossSite = await putNickname(app, {
      cookie,
      host: HOST,
      origin: 'http://evil.test',
      'sec-fetch-site': 'cross-site',
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json<ApiErrorResponse>().error).toBe('csrf');
    expect(profiles.get('alice')).toBeUndefined();
    await app.close();
  });

  it('accepts a same-origin request announced by Sec-Fetch-Site', async () => {
    const { app } = testApp();
    const cookie = await signIn(app);
    const res = await putNickname(app, { cookie, host: HOST, 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    expect(res.json<MeResponse>().user.nickname).toBe('Lice');
    await app.close();
  });

  it('accepts a request whose Origin is this very server, else refuses it', async () => {
    const { app } = testApp();
    const cookie = await signIn(app);
    const same = await putNickname(app, { cookie, host: HOST, origin: `http://${HOST}` });
    expect(same.statusCode).toBe(200);

    const wrongScheme = await putNickname(app, { cookie, host: HOST, origin: `https://${HOST}` });
    expect(wrongScheme.statusCode).toBe(403);
    const otherHost = await putNickname(app, { cookie, host: HOST, origin: 'http://evil.test' });
    expect(otherHost.statusCode).toBe(403);
    await app.close();
  });

  it('takes the public scheme and host from the proxy headers when they are trusted', async () => {
    const { app } = testApp({ config: testConfig({ trustProxy: true }) });
    const cookie = await signIn(app);
    const res = await putNickname(app, {
      cookie,
      host: '127.0.0.1:3000',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': HOST,
      origin: `https://${HOST}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('issues a web join token from the same origin', async () => {
    const { app } = testApp();
    const cookie = await signIn(app);
    const res = await app.inject({
      method: 'POST',
      url: '/api/token',
      headers: { cookie, host: HOST, 'sec-fetch-site': 'same-origin' },
      payload: { room: 'geral', purpose: 'web' },
    });
    expect(res.statusCode).toBe(200);
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(
      res.json<TokenResponse>().token,
    );
    expect(claims.sub).toBe('alice~web');
    expect(claims.video?.canPublishSources).toEqual(['camera']);
    await app.close();
  });

  it('Bearer requests never need the same-origin check and win over the cookie', async () => {
    const { app } = testApp();
    const cookie = await signIn(app);
    const bearerOnly = await putNickname(app, { ...bearer(BOB), origin: 'http://evil.test' });
    expect(bearerOnly.statusCode).toBe(200);
    expect(bearerOnly.json<MeResponse>().user.id).toBe('bob');

    const both = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { ...bearer(BOB), cookie },
    });
    expect(both.json<MeResponse>().user.id).toBe('bob');
    await app.close();
  });

  it.each<[string, (secret: string) => string]>([
    ['an expired session', (secret) => issueSessionToken(ALICE, secret, 60, Date.now() - 120_000)],
    [
      'a tampered signature',
      (secret) => `${issueSessionToken(ALICE, secret, 60).split('.')[0]}.bad`,
    ],
    ['a session signed with another secret', () => issueSessionToken(ALICE, 'x'.repeat(32), 60)],
    ['garbage', () => 'not-a-token'],
  ])('rejects %s with 401', async (_label, token) => {
    const { app, config } = testApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token(config.auth.sessionSecret)}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json<ApiErrorResponse>().error).toBe('unauthorized');
    await app.close();
  });

  it('rejects a session of a user who is no longer in users.json', async () => {
    const config = testConfig();
    const { app } = testApp({ config, users: new UserStore([BOB]) });
    const token = issueSessionToken(ALICE, config.auth.sessionSecret, 60);
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie, with or without a session', async () => {
    const { app } = testApp();
    const cookie = await signIn(app);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['set-cookie']).toBe(
      'concord_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    );

    const anonymous = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(anonymous.statusCode).toBe(204);
    expect(anonymous.headers['set-cookie']).toMatch(/^concord_session=; .*Max-Age=0$/);
    await app.close();
  });
});
