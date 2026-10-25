import { readFile } from 'node:fs/promises';
import { NICKNAME_MAX_LENGTH } from '@concord/shared';
import { moveAsideCorrupt, writeFileAtomic } from './atomic-file';
import type { User, UserStore } from './auth';
import type { Logger } from './logger';

/** What the api remembers about a person beyond users.json (keyed by the Concord user id). */
export interface Profile {
  /** Name as shown on Discord (global_name, else username), or null when never imported. */
  discordName: string | null;
  /** Discord avatar URL (cdn.discordapp.com), or null when never imported. */
  avatarUrl: string | null;
  /** Custom name chosen in the app, or null to use the Discord name. */
  nickname: string | null;
  /** Unix epoch in milliseconds of the last change. */
  updatedAt: number;
}

export interface DiscordProfileData {
  discordName: string | null;
  avatarUrl: string | null;
}

export type ProfileListener = (userId: string) => void;

/** The fields of a Discord user object (`GET /users/@me`, `GET /users/{id}`) the api uses. */
export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const DISCORD_ID_PATTERN = /^\d{1,32}$/;
const AVATAR_HASH_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/** Reads the fields the api needs from a Discord user payload; undefined without a valid id. */
export function parseDiscordUser(value: unknown): DiscordUser | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, username, global_name, avatar } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !DISCORD_ID_PATTERN.test(id)) return undefined;
  return {
    id,
    username: typeof username === 'string' ? username : '',
    global_name: typeof global_name === 'string' ? global_name : null,
    avatar: typeof avatar === 'string' ? avatar : null,
  };
}

/** The name Discord shows for a user: the display name (`global_name`), else the username. */
export function discordDisplayName(user: Pick<DiscordUser, 'username' | 'global_name'>): string {
  return user.global_name && user.global_name.trim() !== '' ? user.global_name : user.username;
}

/** Avatar URL on Discord's CDN; users without a custom avatar get their default one. */
export function discordAvatarUrl(discordUserId: string, avatarHash: string | null): string {
  if (
    avatarHash &&
    AVATAR_HASH_PATTERN.test(avatarHash) &&
    DISCORD_ID_PATTERN.test(discordUserId)
  ) {
    return `https://cdn.discordapp.com/avatars/${discordUserId}/${avatarHash}.png?size=128`;
  }
  const index = DISCORD_ID_PATTERN.test(discordUserId) ? (BigInt(discordUserId) >> 22n) % 6n : 0n;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/** Profile data imported from a Discord user payload. */
export function discordProfileData(user: DiscordUser): DiscordProfileData {
  return {
    discordName: discordDisplayName(user) || null,
    avatarUrl: discordAvatarUrl(user.id, user.avatar),
  };
}

export type NicknameResult = { ok: true; nickname: string | null } | { ok: false; message: string };

// C0/C1 control characters plus the bidirectional overrides/isolates (text-spoofing vectors).
const CONTROL_CHARACTERS = /[\p{Cc}‪-‮⁦-⁩]/u;

/**
 * Normalizes a nickname: trims, collapses runs of whitespace into one space and rejects control
 * characters. Empty (or null) clears the nickname. Length is counted in code points.
 */
export function normalizeNickname(raw: string | null): NicknameResult {
  if (raw === null) return { ok: true, nickname: null };
  const nickname = raw.replace(/\s+/gu, ' ').trim();
  if (nickname === '') return { ok: true, nickname: null };
  if (CONTROL_CHARACTERS.test(nickname)) {
    return { ok: false, message: 'O apelido não pode conter caracteres de controle.' };
  }
  if ([...nickname].length > NICKNAME_MAX_LENGTH) {
    return {
      ok: false,
      message: `O apelido deve ter de 1 a ${NICKNAME_MAX_LENGTH} caracteres.`,
    };
  }
  return { ok: true, nickname };
}

/** Name shown everywhere: nickname, else the Discord name, else the users.json name. */
export function resolveDisplayName(
  user: Pick<User, 'displayName'>,
  profile: Pick<Profile, 'nickname' | 'discordName'> | undefined,
): string {
  return profile?.nickname ?? profile?.discordName ?? user.displayName;
}

export interface ResolvedProfile {
  name: string;
  avatarUrl: string | null;
}

/** Resolves a user id to the name and avatar presence should show (undefined: unknown user). */
export type ProfileResolver = (userId: string) => ResolvedProfile | undefined;

export function createProfileResolver(users: UserStore, profiles: ProfileStore): ProfileResolver {
  return (userId) => {
    const user = users.findById(userId);
    if (!user) return undefined;
    const profile = profiles.get(userId);
    return { name: resolveDisplayName(user, profile), avatarUrl: profile?.avatarUrl ?? null };
  };
}

// ---------------------------------------------------------------------------
// Persistent store
// ---------------------------------------------------------------------------

interface ProfilesFile {
  version: 1;
  profiles: Record<string, Profile>;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** Validates one stored entry; anything malformed is dropped rather than failing the load. */
function parseProfile(value: unknown): Profile | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  const discordName = nullableString(entry.discordName);
  const avatarUrl = nullableString(entry.avatarUrl);
  const nickname = nullableString(entry.nickname);
  if (discordName === undefined || avatarUrl === undefined || nickname === undefined) {
    return undefined;
  }
  const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
  return { discordName, avatarUrl, nickname, updatedAt };
}

export class ProfilesFileError extends Error {
  override name = 'ProfilesFileError';
}

/** Parses the JSON of the profiles file (throws ProfilesFileError when it is not usable). */
export function parseProfilesFile(json: string): Map<string, Profile> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (err) {
    throw new ProfilesFileError(`profiles file is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ProfilesFileError('profiles file must be an object');
  }
  const raw = (data as Record<string, unknown>).profiles;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProfilesFileError('profiles file must have a "profiles" object');
  }
  const profiles = new Map<string, Profile>();
  for (const [id, value] of Object.entries(raw)) {
    const profile = parseProfile(value);
    if (profile) profiles.set(id, profile);
  }
  return profiles;
}

export interface ProfileStoreOptions {
  /** Absolute path of the JSON file; omit for an in-memory store (tests). */
  path?: string;
  log?: Logger;
  now?: () => number;
}

const EMPTY_PROFILE: Omit<Profile, 'updatedAt'> = {
  discordName: null,
  avatarUrl: null,
  nickname: null,
};

/**
 * Profiles (Discord name, avatar, nickname) per user id, persisted as JSON. Writes are atomic
 * (temporary file + rename) and serialized; listeners hear about every effective change.
 */
export class ProfileStore {
  private readonly profiles = new Map<string, Profile>();
  private readonly listeners = new Set<ProfileListener>();
  private readonly path: string | undefined;
  private readonly log: Logger | undefined;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ProfileStoreOptions = {}) {
    this.path = options.path;
    this.log = options.log;
    this.now = options.now ?? Date.now;
  }

  /**
   * Loads the store from `path`. A missing file starts empty; a corrupt one is logged, moved
   * aside to `<path>.corrupt-<timestamp>` (so nothing is lost; only the latest such copy is
   * kept) and the store starts empty.
   */
  static async load(path: string, log?: Logger, now?: () => number): Promise<ProfileStore> {
    const store = new ProfileStore({ path, log, now });
    let json: string;
    try {
      json = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw err;
    }
    try {
      for (const [id, profile] of parseProfilesFile(json)) store.profiles.set(id, profile);
    } catch (err) {
      try {
        const backup = await moveAsideCorrupt(path, store.now());
        log?.error({ err, path, backup }, 'profiles file is corrupt, moved aside; starting empty');
      } catch (renameErr) {
        log?.error(
          { err, renameErr, path },
          'profiles file is corrupt and could not be moved aside; starting empty',
        );
      }
    }
    return store;
  }

  get size(): number {
    return this.profiles.size;
  }

  get(userId: string): Profile | undefined {
    const profile = this.profiles.get(userId);
    return profile ? { ...profile } : undefined;
  }

  onChange(listener: ProfileListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stores the name and avatar imported from Discord; resolves once persisted. */
  setDiscord(userId: string, data: DiscordProfileData): Promise<Profile> {
    return this.update(userId, { discordName: data.discordName, avatarUrl: data.avatarUrl });
  }

  /** Sets (or, with null, clears) the in-app nickname; resolves once persisted. */
  setNickname(userId: string, nickname: string | null): Promise<Profile> {
    return this.update(userId, { nickname });
  }

  private async update(
    userId: string,
    changes: Partial<Omit<Profile, 'updatedAt'>>,
  ): Promise<Profile> {
    const base = this.profiles.get(userId) ?? { ...EMPTY_PROFILE, updatedAt: 0 };
    const changed = (Object.keys(changes) as (keyof typeof changes)[]).some(
      (key) => base[key] !== changes[key],
    );
    if (!changed) return { ...base };
    const next: Profile = { ...base, ...changes, updatedAt: this.now() };
    this.profiles.set(userId, next);
    for (const listener of this.listeners) {
      try {
        listener(userId);
      } catch (err) {
        this.log?.error({ err, userId }, 'profile listener failed');
      }
    }
    await this.persist();
    return { ...next };
  }

  /** Queues a write of the current state; each write sees every change made before it. */
  private persist(): Promise<void> {
    const path = this.path;
    if (!path) return Promise.resolve();
    const run = this.writeChain.then(() => this.writeFile(path));
    // Keep the chain alive after a failure; the caller still sees the rejection.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  private async writeFile(path: string): Promise<void> {
    const data: ProfilesFile = { version: 1, profiles: Object.fromEntries(this.profiles) };
    await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  }
}
