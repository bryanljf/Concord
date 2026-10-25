import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JAM_CACHE_TTL_MS } from '@concord/shared';
import {
  ConfigError,
  deriveLiveKitApiUrl,
  deriveLiveKitWsUrl,
  loadConfig,
  parseRooms,
} from '../src/config';

const base = {
  LIVEKIT_URL: 'wss://concord.example',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: 'secret',
  DISCORD_CLIENT_ID: 'client',
  DISCORD_CLIENT_SECRET: 'secret',
  DISCORD_REDIRECT_URI: 'https://example/callback',
  DISCORD_OAUTH_SCOPES: 'identify',
  AUTH_SESSION_SECRET: 'a'.repeat(32),
  AUTH_SESSION_TTL: '30d',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base, '/srv/concord/apps/api')).toEqual({
      host: '127.0.0.1',
      port: 3000,
      trustProxy: false,
      rooms: ['geral'],
      usersFile: resolve('/srv/concord/apps/api', '../../infra/users.json'),
      profilesFile: resolve('/srv/concord/apps/api', '../../infra/profiles.json'),
      discordBotToken: undefined,
      server: { name: undefined, region: undefined },
      auth: {
        discordClientId: 'client',
        discordClientSecret: 'secret',
        discordRedirectUri: 'https://example/callback',
        discordScopes: 'identify',
        sessionSecret: 'a'.repeat(32),
        sessionTtlSeconds: 2592000,
      },
      livekit: {
        url: 'wss://concord.example',
        localUrl: undefined,
        apiUrl: 'https://concord.example',
        apiKey: 'key',
        apiSecret: 'secret',
      },
      jam: {
        botUrl: undefined,
        botToken: undefined,
        cacheDir: resolve('/srv/concord/apps/api', '../../infra/jam-cache'),
        cacheMaxBytes: 512 * 1024 * 1024,
        cacheTtlMs: JAM_CACHE_TTL_MS,
        stateFile: resolve('/srv/concord/apps/api', '../../infra/jam-state.json'),
        livekitUrl: 'wss://concord.example',
      },
    });
  });

  it('reads every variable', () => {
    const env = {
      ...base,
      HOST: '0.0.0.0',
      PORT: '8080',
      TRUST_PROXY: 'true',
      ROOMS: 'geral, jogos ,filme,geral',
      USERS_FILE: 'data/users.json',
      PROFILES_FILE: '/var/lib/concord/profiles.json',
      DISCORD_BOT_TOKEN: ' bot-token ',
      SERVER_NAME: ' Principal ',
      SERVER_REGION: 'Casa',
      LIVEKIT_LOCAL_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_URL: 'http://127.0.0.1:7880',
      JAM_BOT_URL: 'http://127.0.0.1:3001/',
      JAM_BOT_TOKEN: ' bot-secret ',
      JAM_CACHE_DIR: '/var/lib/concord-jam',
      JAM_CACHE_MAX_MB: '256',
      JAM_CACHE_TTL_HOURS: '12',
      JAM_STATE_FILE: '/var/lib/concord/jam-state.json',
    };
    expect(loadConfig(env, '/srv')).toEqual({
      host: '0.0.0.0',
      port: 8080,
      trustProxy: true,
      rooms: ['geral', 'jogos', 'filme'],
      usersFile: resolve('/srv', 'data/users.json'),
      profilesFile: resolve('/srv', '/var/lib/concord/profiles.json'),
      discordBotToken: 'bot-token',
      server: { name: 'Principal', region: 'Casa' },
      auth: {
        discordClientId: 'client',
        discordClientSecret: 'secret',
        discordRedirectUri: 'https://example/callback',
        discordScopes: 'identify',
        sessionSecret: 'a'.repeat(32),
        sessionTtlSeconds: 2592000,
      },
      livekit: {
        url: 'wss://concord.example',
        localUrl: 'ws://127.0.0.1:7880',
        apiUrl: 'http://127.0.0.1:7880',
        apiKey: 'key',
        apiSecret: 'secret',
      },
      jam: {
        botUrl: 'http://127.0.0.1:3001',
        botToken: 'bot-secret',
        cacheDir: resolve('/srv', '/var/lib/concord-jam'),
        cacheMaxBytes: 256 * 1024 * 1024,
        cacheTtlMs: 12 * 3_600_000,
        stateFile: resolve('/srv', '/var/lib/concord/jam-state.json'),
        // Derived from LIVEKIT_API_URL: the bot reaches LiveKit the way the api does.
        livekitUrl: 'ws://127.0.0.1:7880',
      },
    });
  });

  it('lets JAM_LIVEKIT_URL override the URL the jam bot joins with', () => {
    expect(loadConfig({ ...base, JAM_LIVEKIT_URL: 'ws://livekit:7880/' }).jam.livekitUrl).toBe(
      'ws://livekit:7880',
    );
  });

  it('keeps unused songs 3 hours by default; JAM_CACHE_TTL_HOURS=0 keeps them until evicted', () => {
    expect(JAM_CACHE_TTL_MS).toBe(3 * 3_600_000);
    expect(loadConfig(base).jam.cacheTtlMs).toBe(3 * 3_600_000);
    expect(loadConfig({ ...base, JAM_CACHE_TTL_HOURS: ' ' }).jam.cacheTtlMs).toBe(3 * 3_600_000);
    expect(loadConfig({ ...base, JAM_CACHE_TTL_HOURS: '1' }).jam.cacheTtlMs).toBe(3_600_000);
    expect(loadConfig({ ...base, JAM_CACHE_TTL_HOURS: '0' }).jam.cacheTtlMs).toBe(0);
  });

  it('ignores the former JAM_CACHE_TTL_DAYS', () => {
    expect(loadConfig({ ...base, JAM_CACHE_TTL_DAYS: '7' }).jam.cacheTtlMs).toBe(JAM_CACHE_TTL_MS);
  });

  it.each([
    ['JAM_CACHE_TTL_HOURS', '-1'],
    ['JAM_CACHE_TTL_HOURS', '1.5'],
    ['JAM_CACHE_TTL_HOURS', '3h'],
    ['JAM_CACHE_TTL_HOURS', 'week'],
    ['JAM_BOT_URL', 'ftp://bot'],
    ['JAM_BOT_URL', 'not a url'],
    ['JAM_LIVEKIT_URL', 'http://livekit:7880'],
    ['JAM_CACHE_MAX_MB', '0'],
    ['JAM_CACHE_MAX_MB', '1.5'],
    ['JAM_CACHE_MAX_MB', 'lots'],
  ])('rejects %s=%j', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(ConfigError);
  });

  it.each(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])('requires %s', (name) => {
    expect(() => loadConfig({ ...base, [name]: ' ' })).toThrow(
      new ConfigError(`Missing required environment variable ${name}`),
    );
  });

  it.each(['0', '70000', 'abc', '12.5'])('rejects PORT=%s', (PORT) => {
    expect(() => loadConfig({ ...base, PORT })).toThrow(ConfigError);
  });

  it.each(['1', 'true', 'TRUE'])('parses TRUST_PROXY=%s as true', (TRUST_PROXY) => {
    expect(loadConfig({ ...base, TRUST_PROXY }).trustProxy).toBe(true);
  });

  it.each(['0', 'false', ''])('parses TRUST_PROXY=%j as false', (TRUST_PROXY) => {
    expect(loadConfig({ ...base, TRUST_PROXY }).trustProxy).toBe(false);
  });
});

describe('parseRooms', () => {
  it('trims, drops empty entries and dedupes', () => {
    expect(parseRooms(' geral,, jogos ,geral')).toEqual(['geral', 'jogos']);
  });

  it.each(['', ' , ', 'geral,sala com espaço', '-x', 'a'.repeat(33)])('rejects %j', (raw) => {
    expect(() => parseRooms(raw)).toThrow(ConfigError);
  });
});

describe('deriveLiveKitWsUrl', () => {
  it.each([
    ['http://127.0.0.1:7880', 'ws://127.0.0.1:7880'],
    ['https://concord.example/', 'wss://concord.example'],
    ['ws://localhost:7880', 'ws://localhost:7880'],
  ])('maps %s to %s', (input, expected) => {
    expect(deriveLiveKitWsUrl(input)).toBe(expected);
  });

  it.each(['not a url', 'ftp://concord.example'])('rejects %j', (input) => {
    expect(() => deriveLiveKitWsUrl(input)).toThrow(ConfigError);
  });
});

describe('deriveLiveKitApiUrl', () => {
  it.each([
    ['ws://127.0.0.1:7880', 'http://127.0.0.1:7880'],
    ['wss://concord.example/', 'https://concord.example'],
    ['http://localhost:7880', 'http://localhost:7880'],
    ['https://concord.example/rtc', 'https://concord.example/rtc'],
  ])('maps %s to %s', (input, expected) => {
    expect(deriveLiveKitApiUrl(input)).toBe(expected);
  });

  it.each(['not a url', 'ftp://concord.example'])('rejects %j', (input) => {
    expect(() => deriveLiveKitApiUrl(input)).toThrow(ConfigError);
  });
});
