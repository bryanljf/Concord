import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiErrorResponse, UserInfo } from '@telao/shared';

export interface User {
  id: string;
  displayName: string;
  /** Secret access key (32+ chars, base64url). */
  key: string;
  admin?: boolean;
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
    const { id, displayName, key, admin } = entry;
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
    seen.add(id);
    users.push({ id, displayName: displayName.trim(), key, admin: admin === true });
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

export function toUserInfo(user: User): UserInfo {
  return { id: user.id, displayName: user.displayName, admin: user.admin === true };
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
}

/** Fastify preHandler: validates `Authorization: Bearer <key>` and sets `request.user`. */
export function requireUser(store: UserStore) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply) {
    const key = parseBearer(request.headers.authorization);
    const user = key ? store.findByKey(key) : undefined;
    if (!user) {
      const body: ApiErrorResponse = {
        error: 'unauthorized',
        message: 'Chave de acesso inválida ou ausente.',
      };
      return reply.code(401).header('www-authenticate', 'Bearer').send(body);
    }
    request.user = user;
  };
}

/** Returns the authenticated user; only call from routes guarded by `requireUser`. */
export function getUser(request: FastifyRequest): User {
  if (!request.user) throw new Error('route is missing the requireUser preHandler');
  return request.user;
}
