import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { MeResponse } from '@concord/shared';
import { UserStore } from '../src/auth';
import { testApp, testConfig, ALICE } from './helpers';

/** Starts a login (web client when asked) and returns what the callback must bring back. */
async function startLogin(app: FastifyInstance, client?: 'web') {
  const login = await app.inject({
    method: 'GET',
    url: client ? `/api/auth/discord/login?client=${client}` : '/api/auth/discord/login',
  });
  expect(login.statusCode).toBe(302);
  const state = new URL(login.headers.location as string).searchParams.get('state') as string;
  const cookie = (login.headers['set-cookie'] as string).split(';')[0] as string;
  return { state, cookie };
}

/** Mocks Discord's token exchange and identify answers (an `identify` of null fails the exchange). */
function mockDiscord(identify: object | null) {
  const fetchMock = vi.fn();
  if (identify === null) {
    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
  } else {
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'discord-token', token_type: 'Bearer' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(identify), { status: 200 }));
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function callback(app: FastifyInstance, state: string, cookie: string) {
  return app.inject({
    method: 'GET',
    url: `/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie },
  });
}

describe('Discord OAuth2', () => {
  it('creates a state-protected authorization redirect', async () => {
    const { app } = testApp();
    const response = await app.inject({ method: 'GET', url: '/api/auth/discord/login' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain('https://discord.com/oauth2/authorize');
    expect(response.headers.location).toContain('scope=identify');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    await app.close();
  });

  it('exchanges the code, identifies and issues a session for an allowlisted user', async () => {
    const { app } = testApp({
      users: new UserStore([{ ...ALICE, discordUserId: '123' }]),
    });
    const login = await app.inject({ method: 'GET', url: '/api/auth/discord/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state') as string;
    const cookie = (login.headers['set-cookie'] as string).split(';')[0] as string;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'discord-token', token_type: 'Bearer' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: '123' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const callback = await app.inject({
      method: 'GET',
      url: `/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({ user: { id: 'alice' }, token: expect.any(String) });
    // The desktop keeps its token in the JSON body: no session cookie for it.
    expect(callback.headers['set-cookie']).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    await app.close();
  });

  it('stores the Discord name and avatar before answering, and returns the resolved user', async () => {
    const { app, profiles, presence } = testApp({
      users: new UserStore([{ ...ALICE, discordUserId: '80351110224678912' }]),
    });
    presence.join('geral', { id: 'alice', name: 'Alice', joinedAt: 1_000 });
    const updates: string[] = [];
    presence.subscribe((event) => {
      if (event.type === 'participant_updated') updates.push(event.participant.name);
    });
    const login = await app.inject({ method: 'GET', url: '/api/auth/discord/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state') as string;
    const cookie = (login.headers['set-cookie'] as string).split(';')[0] as string;
    const discordUser = {
      id: '80351110224678912',
      username: 'alice_dc',
      global_name: 'Alice no Discord',
      avatar: '8342729096ea3675442027381ff50dfe',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'discord-token', token_type: 'Bearer' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(discordUser), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const callback = await app.inject({
        method: 'GET',
        url: `/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(callback.statusCode).toBe(200);
      const avatarUrl =
        'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png?size=128';
      expect(callback.json()).toEqual({
        token: expect.any(String),
        user: {
          id: 'alice',
          displayName: 'Alice no Discord',
          admin: true,
          avatarUrl,
          discordName: 'Alice no Discord',
          nickname: null,
        },
      });
      expect(profiles.get('alice')).toMatchObject({ discordName: 'Alice no Discord', avatarUrl });
      expect(updates).toEqual(['Alice no Discord']);
      expect(fetchMock.mock.calls[1]?.[0]).toBe('https://discord.com/api/users/@me');
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('does not store anything for an account outside the allowlist', async () => {
    const { app, profiles } = testApp();
    const login = await app.inject({ method: 'GET', url: '/api/auth/discord/login' });
    const state = new URL(login.headers.location as string).searchParams.get('state') as string;
    const cookie = (login.headers['set-cookie'] as string).split(';')[0] as string;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'discord-token', token_type: 'Bearer' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: '999', username: 'stranger', global_name: null }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const callback = await app.inject({
        method: 'GET',
        url: `/api/auth/discord/callback?code=abc&state=${encodeURIComponent(state)}`,
        headers: { cookie },
      });
      expect(callback.statusCode).toBe(403);
      expect(profiles.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await app.close();
    }
  });

  it('rejects a callback with a mismatched state', async () => {
    const { app } = testApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/discord/callback?code=abc&state=wrong',
      headers: { cookie: 'concord_oauth_state=other' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  describe('web client (?client=web)', () => {
    it('sets the session cookie and sends the browser back to / on success', async () => {
      const { app } = testApp({ users: new UserStore([{ ...ALICE, discordUserId: '123' }]) });
      const { state, cookie } = await startLogin(app, 'web');
      mockDiscord({ id: '123', username: 'alice_dc', global_name: 'Alice no Discord' });
      try {
        const res = await callback(app, state, cookie);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/');
        expect(res.body).toBe('');
        const setCookie = res.headers['set-cookie'] as string;
        expect(setCookie).toMatch(
          /^concord_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000$/,
        );

        // The cookie alone signs the browser in from then on.
        const me = await app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { cookie: setCookie.split(';')[0] as string },
        });
        expect(me.statusCode).toBe(200);
        expect(me.json<MeResponse>().user).toMatchObject({
          id: 'alice',
          displayName: 'Alice no Discord',
        });
      } finally {
        vi.unstubAllGlobals();
        await app.close();
      }
    });

    it('marks the cookie Secure when the site is served over https', async () => {
      const config = testConfig();
      config.auth = {
        ...config.auth,
        discordRedirectUri: 'https://concord.example/api/auth/discord/callback',
      };
      const { app } = testApp({
        config,
        users: new UserStore([{ ...ALICE, discordUserId: '123' }]),
      });
      const { state, cookie } = await startLogin(app, 'web');
      mockDiscord({ id: '123' });
      try {
        const res = await callback(app, state, cookie);
        expect(res.statusCode).toBe(302);
        expect(res.headers['set-cookie']).toMatch(/; Secure$/);
      } finally {
        vi.unstubAllGlobals();
        await app.close();
      }
    });

    it('sends an account outside the allowlist to /?login_error=not_allowlisted, cookieless', async () => {
      const { app, profiles } = testApp();
      const { state, cookie } = await startLogin(app, 'web');
      mockDiscord({ id: '999', username: 'stranger', global_name: null });
      try {
        const res = await callback(app, state, cookie);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/?login_error=not_allowlisted');
        expect(res.headers['set-cookie']).toBeUndefined();
        expect(profiles.size).toBe(0);
      } finally {
        vi.unstubAllGlobals();
        await app.close();
      }
    });

    it('reports a failed exchange with Discord the same way', async () => {
      const { app } = testApp();
      const { state, cookie } = await startLogin(app, 'web');
      mockDiscord(null);
      try {
        const res = await callback(app, state, cookie);
        expect(res.statusCode).toBe(302);
        expect(res.headers.location).toBe('/?login_error=oauth_exchange_failed');
        expect(res.headers['set-cookie']).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
        await app.close();
      }
    });

    it('redirects an invalid state too, once the login is known to be the web one', async () => {
      const { app } = testApp();
      const { state } = await startLogin(app, 'web');
      const res = await callback(app, state, 'concord_oauth_state=other');
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/?login_error=invalid_oauth_state');
      expect(res.headers['set-cookie']).toBeUndefined();
      await app.close();
    });

    it('keeps answering the desktop with JSON when the login did not ask for the web', async () => {
      const { app } = testApp();
      const { state, cookie } = await startLogin(app);
      mockDiscord({ id: '999', username: 'stranger', global_name: null });
      try {
        const res = await callback(app, state, cookie);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toEqual({
          error: 'not_allowlisted',
          message: 'Esta conta não está autorizada.',
        });
        expect(res.headers['set-cookie']).toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
        await app.close();
      }
    });
  });
});
