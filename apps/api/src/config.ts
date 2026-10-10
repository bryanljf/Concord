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
    livekit: {
      url,
      localUrl: env.LIVEKIT_LOCAL_URL?.trim() || undefined,
      apiUrl: env.LIVEKIT_API_URL?.trim() || deriveLiveKitApiUrl(url),
      apiKey: required(env, 'LIVEKIT_API_KEY'),
      apiSecret: required(env, 'LIVEKIT_API_SECRET'),
    },
  };
}
