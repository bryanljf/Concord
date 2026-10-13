import { resolve } from 'node:path';
import { ROOM_ID_PATTERN, type RoomId } from '@concord/shared';

export interface LiveKitConfig {
  /** URL (ws:// or wss://) handed to clients in the token response. */
  url: string;
  /**
   * Optional URL handed to clients whose request comes from loopback. Lets the person
   * hosting the server on their own PC connect without relying on NAT hairpinning.
   */
  localUrl: string | undefined;
  /** HTTP(S) URL the api uses to call the LiveKit server API (RoomService). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
}

export interface ApiConfig {
  host: string;
  port: number;
  /** Trust `X-Forwarded-*` headers (set when running behind Caddy). */
  trustProxy: boolean;
  rooms: RoomId[];
  /** Absolute path to `users.json`. */
  usersFile: string;
  /** Absolute path to the profiles file (Discord names, avatars, nicknames); written by the api. */
  profilesFile: string;
  /** Optional Discord bot token used to refresh names/avatars periodically. */
  discordBotToken: string | undefined;
  auth: {
    discordClientId: string;
    discordClientSecret: string;
    discordRedirectUri: string;
    discordScopes: string;
    sessionSecret: string;
    sessionTtlSeconds: number;
  };
  livekit: LiveKitConfig;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`Missing required environment variable ${name}`);
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

function parseBoolean(raw: string | undefined): boolean {
  return raw === '1' || raw?.toLowerCase() === 'true';
}

function parseDuration(raw: string, name: string): number {
  const match = /^(\d+)([smhd])$/.exec(raw.trim().toLowerCase());
  if (!match) throw new ConfigError(`${name} must be a duration such as 30d`);
  const value = Number(match[1]);
  const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as 's' | 'm' | 'h' | 'd'];
  const seconds = value * multiplier;
  if (!Number.isSafeInteger(seconds) || seconds < 60) {
    throw new ConfigError(`${name} must be at least 60 seconds`);
  }

  return seconds;
}

function parseSessionSecret(env: Env): string {
  const value = required(env, 'AUTH_SESSION_SECRET');
  if (value.length < 32)
    throw new ConfigError('AUTH_SESSION_SECRET must be at least 32 characters');
  return value;
}

function parseDiscordRedirectUri(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new ConfigError('DISCORD_REDIRECT_URI must be a valid http(s) URL');
  }
  return raw;
}

function parseDiscordScopes(raw: string): string {
  const scopes = raw.split(/\s+/).filter(Boolean);
  if (!scopes.includes('identify')) {
    throw new ConfigError('DISCORD_OAUTH_SCOPES must include identify');
  }
  return scopes.join(' ');
}

export function parseRooms(raw: string | undefined): RoomId[] {
  const rooms = (raw ?? '')
    .split(',')
    .map((room) => room.trim())
    .filter(Boolean);
  if (rooms.length === 0) throw new ConfigError('ROOMS must list at least one room');
  const invalid = rooms.find((room) => !ROOM_ID_PATTERN.test(room));
  if (invalid) throw new ConfigError(`Invalid room name "${invalid}" in ROOMS`);
  return [...new Set(rooms)];
}

/** Turns the client-facing LiveKit URL into the HTTP URL used for server API calls. */
export function deriveLiveKitApiUrl(livekitUrl: string): string {
  let url: URL;
  try {
    url = new URL(livekitUrl);
  } catch {
    throw new ConfigError(`LIVEKIT_URL is not a valid URL: "${livekitUrl}"`);
  }
  switch (url.protocol) {
    case 'ws:':
      url.protocol = 'http:';
      break;
    case 'wss:':
      url.protocol = 'https:';
      break;
    case 'http:':
    case 'https:':
      break;
    default:
      throw new ConfigError('LIVEKIT_URL must start with ws://, wss://, http:// or https://');
  }
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): ApiConfig {
  const url = required(env, 'LIVEKIT_URL');
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: parsePort(env.PORT),
    trustProxy: parseBoolean(env.TRUST_PROXY),
    rooms: parseRooms(env.ROOMS ?? 'geral'),
    usersFile: resolve(cwd, env.USERS_FILE?.trim() || '../../infra/users.json'),
    profilesFile: resolve(cwd, env.PROFILES_FILE?.trim() || '../../infra/profiles.json'),
    discordBotToken: env.DISCORD_BOT_TOKEN?.trim() || undefined,
    auth: {
      discordClientId: required(env, 'DISCORD_CLIENT_ID'),
      discordClientSecret: required(env, 'DISCORD_CLIENT_SECRET'),
      discordRedirectUri: parseDiscordRedirectUri(required(env, 'DISCORD_REDIRECT_URI')),
      discordScopes: parseDiscordScopes(required(env, 'DISCORD_OAUTH_SCOPES')),
      sessionSecret: parseSessionSecret(env),
      sessionTtlSeconds: parseDuration(required(env, 'AUTH_SESSION_TTL'), 'AUTH_SESSION_TTL'),
    },
    livekit: {
      url,
      localUrl: env.LIVEKIT_LOCAL_URL?.trim() || undefined,
      apiUrl: env.LIVEKIT_API_URL?.trim() || deriveLiveKitApiUrl(url),
      apiKey: required(env, 'LIVEKIT_API_KEY'),
      apiSecret: required(env, 'LIVEKIT_API_SECRET'),
    },
  };
}
