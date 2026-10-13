import { createHash } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { vi } from 'vitest';
import { buildApp, type BuildAppOptions } from '../src/app';
import { UserStore, type User } from '../src/auth';
import type { ApiConfig } from '../src/config';
import { PresenceStore } from '../src/presence-store';
import { createProfileResolver, ProfileStore } from '../src/profiles';

export const API_KEY = 'devkey';
export const API_SECRET = '0123456789abcdef0123456789abcdef';

export const ALICE: User = {
  id: 'alice',
  displayName: 'Alice',
  key: 'alice-key-0123456789abcdefghij',
  admin: true,
};
export const BOB: User = {
  id: 'bob',
  displayName: 'Bob',
  key: 'bob-key-0123456789abcdefghij',
  admin: false,
};

export function testConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    trustProxy: false,
    rooms: ['geral', 'jogos'],
    usersFile: 'unused/users.json',
    profilesFile: 'unused/profiles.json',
    discordBotToken: undefined,
    auth: {
      discordClientId: 'client-id',
      discordClientSecret: 'client-secret',
      discordRedirectUri: 'http://localhost/api/auth/discord/callback',
      discordScopes: 'identify',
      sessionSecret: 'session-secret-012345678901234567890123',
      sessionTtlSeconds: 2592000,
    },
    livekit: {
      url: 'wss://concord.example',
      localUrl: undefined,
      apiUrl: 'https://concord.example',
      apiKey: API_KEY,
      apiSecret: API_SECRET,
    },
    ...overrides,
  };
}

/** Builds an app with in-memory users, profiles and presence (no network, no file I/O). */
export function testApp(overrides: Partial<BuildAppOptions> = {}) {
  const config = overrides.config ?? testConfig();
  const users = overrides.users ?? new UserStore([ALICE, BOB]);
  const profiles = overrides.profiles ?? new ProfileStore();
  const presence =
    overrides.presence ?? new PresenceStore(config.rooms, createProfileResolver(users, profiles));
  const app = buildApp({ ...overrides, config, users, presence, profiles });
  return { app, config, users, presence, profiles };
}

export function bearer(user: User): { authorization: string } {
  return { authorization: `Bearer ${user.key}` };
}

/** Signs a webhook body the way livekit-server does: a JWT whose sha256 claim covers the body. */
export async function signWebhook(body: string, secret = API_SECRET): Promise<string> {
  const token = new AccessToken(API_KEY, secret, { ttl: '5m' });
  token.sha256 = createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

export function fakeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
