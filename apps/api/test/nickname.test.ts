import type { FastifyInstance } from 'fastify';
import { TokenVerifier } from 'livekit-server-sdk';
import { describe, expect, it } from 'vitest';
import {
  NICKNAME_MAX_LENGTH,
  type ApiErrorResponse,
  type MeResponse,
  type PresenceEvent,
  type TokenResponse,
} from '@concord/shared';
import type { User } from '../src/auth';
import { ALICE, API_KEY, API_SECRET, BOB, bearer, testApp } from './helpers';

function putNickname(
  app: FastifyInstance,
  payload: unknown,
  user: User | null = ALICE,
  remoteAddress?: string,
) {
  return app.inject({
    method: 'PUT',
    url: '/api/me/nickname',
    headers: user ? bearer(user) : {},
    payload: payload as object,
    remoteAddress,
  });
}

describe('PUT /api/me/nickname', () => {
  it('stores the nickname and answers with the updated MeResponse', async () => {
    const { app, profiles } = testApp();
    await profiles.setDiscord('alice', {
      discordName: 'Alice D.',
      avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png',
    });

    const res = await putNickname(app, { nickname: '  Lice   do  Rock ' });
    expect(res.statusCode).toBe(200);
    const expected: MeResponse = {
      user: {
        id: 'alice',
        displayName: 'Lice do Rock',
        admin: true,
        avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png',
        discordName: 'Alice D.',
        nickname: 'Lice do Rock',
      },
    };
    expect(res.json<MeResponse>()).toEqual(expected);
    expect(profiles.get('alice')?.nickname).toBe('Lice do Rock');

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(ALICE) });
    expect(me.json<MeResponse>()).toEqual(expected);
    await app.close();
  });

  it.each<[string, unknown]>([
    ['null', { nickname: null }],
    ['an empty string', { nickname: '' }],
    ['whitespace only', { nickname: '   ' }],
  ])('clears the nickname with %s, falling back to the Discord name', async (_label, payload) => {
    const { app, profiles } = testApp();
    await profiles.setDiscord('alice', { discordName: 'Alice D.', avatarUrl: null });
    await profiles.setNickname('alice', 'Lice');

    const res = await putNickname(app, payload);
    expect(res.statusCode).toBe(200);
    expect(res.json<MeResponse>().user).toMatchObject({
      displayName: 'Alice D.',
      nickname: null,
      discordName: 'Alice D.',
    });
    await app.close();
  });

  it('falls back to the users.json name when nothing came from Discord', async () => {
    const { app } = testApp();
    const res = await putNickname(app, { nickname: null }, BOB);
    expect(res.json<MeResponse>().user).toEqual({
      id: 'bob',
      displayName: 'Bob',
      admin: false,
      avatarUrl: null,
      discordName: null,
      nickname: null,
    });
    await app.close();
  });

  it.each<[string, unknown]>([
    ['too long', { nickname: 'x'.repeat(NICKNAME_MAX_LENGTH + 1) }],
    ['a control character', { nickname: 'Li\u0007ce' }],
  ])('rejects a nickname that is %s with invalid_nickname', async (_label, payload) => {
    const { app, profiles } = testApp();
    const res = await putNickname(app, payload);
    expect(res.statusCode).toBe(400);
    const body = res.json<ApiErrorResponse>();
    expect(body.error).toBe('invalid_nickname');
    expect(body.message).toMatch(/apelido/);
    expect(profiles.get('alice')).toBeUndefined();
    await app.close();
  });

  it.each<[string, unknown]>([
    ['a missing field', {}],
    ['an object', { nickname: { nested: true } }],
    ['a huge string', { nickname: 'x'.repeat(10_000) }],
  ])('rejects %s with invalid_request', async (_label, payload) => {
    const { app } = testApp();
    const res = await putNickname(app, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorResponse>().error).toBe('invalid_request');
    await app.close();
  });

  it('requires a valid key', async () => {
    const { app, profiles } = testApp();
    const res = await putNickname(app, { nickname: 'Lice' }, null);
    expect(res.statusCode).toBe(401);
    expect(res.json<ApiErrorResponse>().error).toBe('unauthorized');
    expect(profiles.size).toBe(0);
    await app.close();
  });

  it('rate limits to 10 changes per minute per IP', async () => {
    const { app } = testApp();
    for (let i = 0; i < 10; i += 1) {
      const res = await putNickname(app, { nickname: `Lice ${i}` }, ALICE, '203.0.113.1');
      expect(res.statusCode, `request ${i + 1}`).toBe(200);
    }
    const limited = await putNickname(app, { nickname: 'Lice 11' }, ALICE, '203.0.113.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.json<ApiErrorResponse>().error).toBe('rate_limited');

    const other = await putNickname(app, { nickname: 'Bobão' }, BOB, '203.0.113.2');
    expect(other.statusCode).toBe(200);
    await app.close();
  });

  it('announces the new name to presence (participant_updated) and uses it in LiveKit tokens', async () => {
    const { app, presence } = testApp();
    presence.join('geral', { id: 'alice', name: 'Alice', joinedAt: 1_000 });
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));

    await putNickname(app, { nickname: 'Lice' });
    expect(events).toEqual([
      {
        type: 'participant_updated',
        room: 'geral',
        participant: {
          id: 'alice',
          name: 'Lice',
          streaming: false,
          joinedAt: 1_000,
          avatarUrl: null,
          camera: false,
          client: 'desktop',
        },
      },
    ]);

    // Same name again: nothing to announce.
    await putNickname(app, { nickname: 'Lice' });
    expect(events).toHaveLength(1);

    const token = await app.inject({
      method: 'POST',
      url: '/api/token',
      headers: bearer(ALICE),
      payload: { room: 'geral' },
    });
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(
      token.json<TokenResponse>().token,
    );
    expect(claims.name).toBe('Lice');
    await app.close();
  });

  it('stops forwarding profile changes to presence once the app is closed', async () => {
    const { app, presence, profiles } = testApp();
    presence.join('geral', { id: 'alice', name: 'Alice', joinedAt: 1_000 });
    await app.ready();
    await app.close();
    const events: PresenceEvent[] = [];
    presence.subscribe((event) => events.push(event));
    await profiles.setNickname('alice', 'Lice');
    expect(events).toEqual([]);
  });
});
