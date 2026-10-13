import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, UserInfo } from '@concord/shared';
import { resolveDisplayName, type Profile } from './profiles';

export interface User {
  id: string;
  displayName: string;
  /** Secret access key (32+ chars, base64url). */
  key: string;
  admin?: boolean;
  discordUserId?: string;
}

export interface UsersFile {
  users: User[];
}

export const USER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const MIN_KEY_LENGTH = 16;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the `requireUser` preHandler. */
    user?: User;
  }
}

export class UsersFileError extends Error {
  override name = 'UsersFileError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the raw JSON of `users.json` and returns the user list. */
export function parseUsersFile(json: string): User[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new UsersFileError(`users.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(data) || !Array.isArray(data.users)) {
    throw new UsersFileError('users.json must be an object with a "users" array');
  }
  const users: User[] = [];
  const seen = new Set<string>();
  data.users.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) throw new UsersFileError(`users[${index}] must be an object`);
    const { id, displayName, key, admin, discordUserId } = entry;
    if (typeof id !== 'string' || !USER_ID_PATTERN.test(id)) {
      throw new UsersFileError(`users[${index}].id must match ${USER_ID_PATTERN}`);
    }
    if (seen.has(id)) throw new UsersFileError(`duplicate user id "${id}"`);
    if (typeof displayName !== 'string' || displayName.trim() === '') {
      throw new UsersFileError(`users[${index}].displayName must be a non-empty string`);
    }
    if (typeof key !== 'string' || key.length < MIN_KEY_LENGTH) {
      throw new UsersFileError(`users[${index}].key must be at least ${MIN_KEY_LENGTH} chars`);
    }
    if (admin !== undefined && typeof admin !== 'boolean') {
      throw new UsersFileError(`users[${index}].admin must be a boolean`);
    }
    if (
      discordUserId !== undefined &&
      (typeof discordUserId !== 'string' || !/^\d{1,32}$/.test(discordUserId))
    ) {
      throw new UsersFileError(`users[${index}].discordUserId must be a Discord user id`);
    }
    seen.add(id);
    users.push({
      id,
      displayName: displayName.trim(),
      key,
      admin: admin === true,
      ...(discordUserId === undefined ? {} : { discordUserId }),
    });
  });
  return users;
}

/** Constant-time string comparison that does not leak the length of either side. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  const [scheme, value] = parts;
  if (scheme?.toLowerCase() !== 'bearer' || !value) return undefined;
  return value;
}

/** Public view of a user, with the name resolved from the profile (nickname, Discord, users.json). */
export function toUserInfo(user: User, profile: Profile | undefined): UserInfo {
  return {
    id: user.id,
    displayName: resolveDisplayName(user, profile),
    admin: user.admin === true,
    avatarUrl: profile?.avatarUrl ?? null,
    discordName: profile?.discordName ?? null,
    nickname: profile?.nickname ?? null,
  };
}

export class UserStore {
  private users: readonly User[] = [];

  constructor(users: readonly User[] = []) {
    this.replace(users);
  }

  static async fromFile(path: string): Promise<UserStore> {
    const store = new UserStore();
    await store.reloadFromFile(path);
    return store;
  }

  get size(): number {
    return this.users.length;
  }

  replace(users: readonly User[]): void {
    const ids = new Set<string>();
    for (const user of users) {
      if (ids.has(user.id)) throw new UsersFileError(`duplicate user id "${user.id}"`);
      ids.add(user.id);
    }
    this.users = [...users];
  }

  async reloadFromFile(path: string): Promise<void> {
    const json = await readFile(path, 'utf8');
    this.replace(parseUsersFile(json));
  }

  all(): readonly User[] {
    return this.users;
  }

  findById(id: string): User | undefined {
    return this.users.find((user) => user.id === id);
  }

  /** Looks a user up by access key, comparing against every key to keep timing uniform. */
  findByKey(key: string): User | undefined {
    let found: User | undefined;
    for (const user of this.users) {
      if (safeEqual(user.key, key)) found = user;
    }
    return found;
  }

  findByDiscordUserId(id: string): User | undefined {
    return this.users.find((user) => user.discordUserId === id);
  }
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function issueSessionToken(
  user: User,
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const payload = encode({ sub: user.id, exp: Math.floor(now / 1000) + ttlSeconds });
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function userFromSessionToken(
  token: string,
  store: UserStore,
  secret: string,
  now = Date.now(),
): User | undefined {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return undefined;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (
      typeof value.sub !== 'string' ||
      typeof value.exp !== 'number' ||
      value.exp <= Math.floor(now / 1000)
    )
      return undefined;
    return store.findById(value.sub);
  } catch {
    return undefined;
  }
}

/** Fastify preHandler: validates `Authorization: Bearer <key>` and sets `request.user`. */
export function requireUser(store: UserStore, sessionSecret?: string) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const key = parseBearer(request.headers.authorization);
    const user = key ? store.findByKey(key) : undefined;
    const sessionUser =
      !user && sessionSecret && key ? userFromSessionToken(key, store, sessionSecret) : undefined;
    if (!user && !sessionUser) {
      const body: ApiErrorResponse = {
        error: 'unauthorized',
        message: 'Chave de acesso inválida ou ausente.',
      };
      return reply.code(401).header('www-authenticate', 'Bearer').send(body);
    }
    request.user = user ?? sessionUser;
  };
}

/** Returns the authenticated user; only call from routes guarded by `requireUser`. */
export function getUser(request: FastifyRequest): User {
  if (!request.user) throw new Error('route is missing the requireUser preHandler');
  return request.user;
}
