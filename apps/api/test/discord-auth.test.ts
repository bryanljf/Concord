import { describe, expect, it, vi } from 'vitest';
import { UserStore } from '../src/auth';
import { testApp, ALICE } from './helpers';

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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
    await app.close();
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
});
