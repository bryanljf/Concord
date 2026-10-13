import { describe, expect, it } from 'vitest';
import type { ApiErrorResponse, MeResponse } from '@concord/shared';
import { parseBearer, parseUsersFile, UsersFileError, UserStore } from '../src/auth';
import { ALICE, BOB, bearer, testApp } from './helpers';

describe('parseBearer', () => {
  it.each<[string, string]>([
    ['Bearer abc', 'abc'],
    ['bearer abc', 'abc'],
    ['  Bearer   abc  ', 'abc'],
  ])('extracts the key from %j', (header, key) => {
    expect(parseBearer(header)).toBe(key);
  });

  it.each<[string | undefined]>([
    [undefined],
    [''],
    ['Bearer'],
    ['Bearer '],
    ['Basic abc'],
    ['Bearer a b'],
    ['abc'],
  ])('rejects %j', (header) => {
    expect(parseBearer(header)).toBeUndefined();
  });
});

describe('parseUsersFile', () => {
  const file = (users: unknown): string => JSON.stringify({ users });
  const key = 'k'.repeat(16);

  it('normalizes a valid file', () => {
    expect(parseUsersFile(file([{ id: 'ana', displayName: '  Ana ', key }, BOB]))).toEqual([
      { id: 'ana', displayName: 'Ana', key, admin: false },
      BOB,
    ]);
  });

  it.each<[string, string]>([
    ['invalid JSON', '{'],
    ['a missing users array', '{}'],
    ['a non-object entry', file(['x'])],
    ['an invalid id', file([{ id: 'A!', displayName: 'A', key }])],
    [
      'an id that looks like an auxiliary identity',
      file([{ id: 'ana~popout', displayName: 'A', key }]),
    ],
    ['a duplicate id', file([ALICE, { ...BOB, id: ALICE.id }])],
    ['an empty displayName', file([{ id: 'ana', displayName: ' ', key }])],
    ['a short key', file([{ id: 'ana', displayName: 'Ana', key: 'short' }])],
    ['a non-boolean admin', file([{ id: 'ana', displayName: 'Ana', key, admin: 'yes' }])],
  ])('rejects %s', (_label, json) => {
    expect(() => parseUsersFile(json)).toThrow(UsersFileError);
  });
});

describe('UserStore.findByKey', () => {
  const store = new UserStore([ALICE, BOB]);

  it('finds the user owning the key', () => {
    expect(store.findByKey(BOB.key)).toEqual(BOB);
    expect(store.findByKey(ALICE.key)).toEqual(ALICE);
  });

  it('rejects unknown, partial and empty keys', () => {
    expect(store.findByKey('nope')).toBeUndefined();
    expect(store.findByKey(ALICE.key.slice(0, -1))).toBeUndefined();
    expect(store.findByKey(`${ALICE.key}x`)).toBeUndefined();
    expect(store.findByKey('')).toBeUndefined();
  });
});

describe('GET /api/me', () => {
  it('returns the user for a valid key', async () => {
    const { app } = testApp();
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: bearer(ALICE) });
    expect(res.statusCode).toBe(200);
    expect(res.json<MeResponse>()).toEqual({
      user: {
        id: 'alice',
        displayName: 'Alice',
        admin: true,
        avatarUrl: null,
        discordName: null,
        nickname: null,
      },
    });
    await app.close();
  });

  it.each<[string, Record<string, string>]>([
    ['no Authorization header', {}],
    ['an unknown key', { authorization: 'Bearer nope-nope-nope-nope-nope' }],
    ['a wrong scheme', { authorization: `Basic ${ALICE.key}` }],
  ])('rejects %s with 401', async (_label, headers) => {
    const { app } = testApp();
    const res = await app.inject({ method: 'GET', url: '/api/me', headers });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json<ApiErrorResponse>()).toEqual({
      error: 'unauthorized',
      message: expect.any(String),
    });
    await app.close();
  });
});
