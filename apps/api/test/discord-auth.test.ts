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
});
