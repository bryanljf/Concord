import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, deriveLiveKitApiUrl, loadConfig, parseRooms } from '../src/config';

const base = {
  LIVEKIT_URL: 'wss://concord.example',
  LIVEKIT_API_KEY: 'key',
  LIVEKIT_API_SECRET: 'secret',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(base, '/srv/concord/apps/api')).toEqual({
      host: '127.0.0.1',
      port: 3000,
      trustProxy: false,
      rooms: ['geral'],
      usersFile: resolve('/srv/concord/apps/api', '../../infra/users.json'),
      livekit: {
        url: 'wss://concord.example',
        localUrl: undefined,
        apiUrl: 'https://concord.example',
        apiKey: 'key',
        apiSecret: 'secret',
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
      LIVEKIT_LOCAL_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_URL: 'http://127.0.0.1:7880',
    };
    expect(loadConfig(env, '/srv')).toEqual({
      host: '0.0.0.0',
      port: 8080,
      trustProxy: true,
      rooms: ['geral', 'jogos', 'filme'],
      usersFile: resolve('/srv', 'data/users.json'),
      livekit: {
        url: 'wss://concord.example',
        localUrl: 'ws://127.0.0.1:7880',
        apiUrl: 'http://127.0.0.1:7880',
        apiKey: 'key',
        apiSecret: 'secret',
      },
    });
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
