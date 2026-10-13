import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { UserStore } from '../src/auth';
import { PresenceStore } from '../src/presence-store';
import { ProfileStore } from '../src/profiles';
import { testConfig } from './helpers';

describe('Discord OAuth rate limit', () => {
  it('limits /api/auth/discord/login to 10 requests per minute per IP', async () => {
    const config = testConfig();
    const app = buildApp({
      config,
      users: new UserStore([]),
      presence: new PresenceStore(config.rooms),
      profiles: new ProfileStore(),
      webhookReceiver: {
        receive: async () => {
          throw new Error('unused');
        },
      },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/api/auth/discord/login' });
      statuses.push(res.statusCode);
    }
    await app.close();
    expect(statuses.slice(0, 10).every((s) => s === 302)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
