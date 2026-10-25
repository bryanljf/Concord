import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NICKNAME_MAX_LENGTH } from '@concord/shared';
import { UserStore } from '../src/auth';
import {
  createProfileResolver,
  discordAvatarUrl,
  discordDisplayName,
  discordProfileData,
  normalizeNickname,
  parseDiscordUser,
  parseProfilesFile,
  ProfilesFileError,
  ProfileStore,
  resolveDisplayName,
} from '../src/profiles';
import { ALICE, BOB, fakeLogger } from './helpers';

describe('discordDisplayName', () => {
  it('prefers global_name and falls back to the username', () => {
    expect(discordDisplayName({ username: 'bryan', global_name: 'Bryan F.' })).toBe('Bryan F.');
    expect(discordDisplayName({ username: 'bryan', global_name: null })).toBe('bryan');
    expect(discordDisplayName({ username: 'bryan', global_name: '' })).toBe('bryan');
    expect(discordDisplayName({ username: 'bryan', global_name: '   ' })).toBe('bryan');
  });

  it('keeps the Discord name exactly as it is', () => {
    expect(discordDisplayName({ username: 'x', global_name: 'ÁgUa 🌊 ~' })).toBe('ÁgUa 🌊 ~');
  });
});

describe('discordAvatarUrl', () => {
  it('builds the CDN URL from the avatar hash', () => {
    expect(discordAvatarUrl('80351110224678912', '8342729096ea3675442027381ff50dfe')).toBe(
      'https://cdn.discordapp.com/avatars/80351110224678912/8342729096ea3675442027381ff50dfe.png?size=128',
    );
    expect(discordAvatarUrl('80351110224678912', 'a_1269e74af4df7417b13759eae50c83dc')).toBe(
      'https://cdn.discordapp.com/avatars/80351110224678912/a_1269e74af4df7417b13759eae50c83dc.png?size=128',
    );
  });

  it.each<[string, number]>([
    ['80351110224678912', 5],
    ['175928847299117063', 2],
    ['222222222222222222', 3],
    ['123456789012345678', 0],
  ])('uses the default avatar (id >> 22) %% 6 for %s', (id, index) => {
    expect(discordAvatarUrl(id, null)).toBe(
      `https://cdn.discordapp.com/embed/avatars/${index}.png`,
    );
  });

  it('never builds a URL from a malformed hash', () => {
    expect(discordAvatarUrl('222222222222222222', '../../evil')).toBe(
      'https://cdn.discordapp.com/embed/avatars/3.png',
    );
  });
});

describe('parseDiscordUser / discordProfileData', () => {
  it('reads id, username, global_name and avatar', () => {
    const user = parseDiscordUser({
      id: '222222222222222222',
      username: 'ana',
      global_name: 'Ana Clara',
      avatar: null,
      discriminator: '0',
    });
    expect(user).toEqual({
      id: '222222222222222222',
      username: 'ana',
      global_name: 'Ana Clara',
      avatar: null,
    });
    expect(user && discordProfileData(user)).toEqual({
      discordName: 'Ana Clara',
      avatarUrl: 'https://cdn.discordapp.com/embed/avatars/3.png',
    });
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['a missing id', { username: 'x' }],
    ['a non-numeric id', { id: 'abc', username: 'x' }],
  ])('rejects %s', (_label, value) => {
    expect(parseDiscordUser(value)).toBeUndefined();
  });

  it('tolerates a missing username', () => {
    const user = parseDiscordUser({ id: '1' });
    expect(user && discordProfileData(user).discordName).toBeNull();
  });
});

describe('normalizeNickname', () => {
  it.each<[string | null, string | null]>([
    [null, null],
    ['', null],
    ['   ', null],
    ['  Bry  ', 'Bry'],
    ['Bryan \t  do\n  Rock', 'Bryan do Rock'],
    ['a', 'a'],
    ['🎮'.repeat(NICKNAME_MAX_LENGTH), '🎮'.repeat(NICKNAME_MAX_LENGTH)],
  ])('normalizes %j to %j', (raw, nickname) => {
    expect(normalizeNickname(raw)).toEqual({ ok: true, nickname });
  });

  it('counts code points, not UTF-16 units', () => {
    expect(normalizeNickname('😀'.repeat(NICKNAME_MAX_LENGTH)).ok).toBe(true);
    expect(normalizeNickname('😀'.repeat(NICKNAME_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it.each<[string, string]>([
    ['too long', 'x'.repeat(NICKNAME_MAX_LENGTH + 1)],
    ['a NUL character', 'Bry\u0000an'],
    ['an escape character', 'Bry\u001b[31man'],
    ['a DEL character', 'Bry\u007fan'],
    ['a bidi override', 'Bry‮an'],
  ])('rejects %s with a pt-BR message', (_label, raw) => {
    const result = normalizeNickname(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/apelido/);
  });
});

describe('resolveDisplayName', () => {
  const user = { displayName: 'Alice (users.json)' };
  it('prefers nickname, then Discord name, then users.json', () => {
    expect(resolveDisplayName(user, { nickname: 'Lice', discordName: 'Alice D.' })).toBe('Lice');
    expect(resolveDisplayName(user, { nickname: null, discordName: 'Alice D.' })).toBe('Alice D.');
    expect(resolveDisplayName(user, { nickname: null, discordName: null })).toBe(
      'Alice (users.json)',
    );
    expect(resolveDisplayName(user, undefined)).toBe('Alice (users.json)');
  });
});

describe('createProfileResolver', () => {
  it('resolves known users and ignores unknown ids', async () => {
    const profiles = new ProfileStore();
    const resolve = createProfileResolver(new UserStore([ALICE, BOB]), profiles);
    await profiles.setDiscord('alice', { discordName: 'Alice D.', avatarUrl: 'https://a/1.png' });
    expect(resolve('alice')).toEqual({ name: 'Alice D.', avatarUrl: 'https://a/1.png' });
    expect(resolve('bob')).toEqual({ name: 'Bob', avatarUrl: null });
    expect(resolve('ghost')).toBeUndefined();
  });
});

describe('parseProfilesFile', () => {
  it('drops malformed entries and keeps the valid ones', () => {
    const profiles = parseProfilesFile(
      JSON.stringify({
        version: 1,
        profiles: {
          alice: { discordName: 'A', avatarUrl: null, nickname: 'Lice', updatedAt: 5 },
          bob: { discordName: 42 },
          carol: 'nope',
        },
      }),
    );
    expect([...profiles]).toEqual([
      ['alice', { discordName: 'A', avatarUrl: null, nickname: 'Lice', updatedAt: 5 }],
    ]);
  });

  it.each(['{', '[]', '{"profiles": []}', '{}'])('rejects %j', (json) => {
    expect(() => parseProfilesFile(json)).toThrow(ProfilesFileError);
  });
});

describe('ProfileStore', () => {
  let dir: string;
  let path: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'concord-profiles-'));
    path = join(dir, 'data', 'profiles.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('starts empty when the file does not exist', async () => {
    const store = await ProfileStore.load(path);
    expect(store.size).toBe(0);
    expect(store.get('alice')).toBeUndefined();
  });

  it('persists atomically and reloads what it wrote', async () => {
    const store = await ProfileStore.load(path, undefined, () => 1234);
    await store.setDiscord('alice', { discordName: 'Alice D.', avatarUrl: 'https://a/1.png' });
    await store.setNickname('alice', 'Lice');
    await store.setNickname('bob', 'Bobão');

    const reloaded = await ProfileStore.load(path);
    expect(reloaded.get('alice')).toEqual({
      discordName: 'Alice D.',
      avatarUrl: 'https://a/1.png',
      nickname: 'Lice',
      updatedAt: 1234,
    });
    expect(reloaded.get('bob')).toEqual({
      discordName: null,
      avatarUrl: null,
      nickname: 'Bobão',
      updatedAt: 1234,
    });
    // No temporary files are left behind.
    expect(await readdir(join(dir, 'data'))).toEqual(['profiles.json']);
  });

  it('serializes concurrent writes so the file ends with the latest state', async () => {
    const store = await ProfileStore.load(path);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.setNickname(`user${i}`, `Nick ${i}`)),
    );
    const data = JSON.parse(await readFile(path, 'utf8')) as {
      profiles: Record<string, unknown>;
    };
    expect(Object.keys(data.profiles)).toHaveLength(20);
  });

  it('moves a corrupt file aside, logs it and starts empty', async () => {
    await mkdir(join(dir, 'data'));
    await writeFile(path, '{ "profiles": { oops');
    const log = fakeLogger();
    const store = await ProfileStore.load(path, log, () => 99);
    expect(store.size).toBe(0);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(await readFile(`${path}.corrupt-99`, 'utf8')).toBe('{ "profiles": { oops');

    await store.setNickname('alice', 'Lice');
    expect((await ProfileStore.load(path)).get('alice')?.nickname).toBe('Lice');
  });

  it('keeps only the latest copy of a corrupt file', async () => {
    await mkdir(join(dir, 'data'));
    await writeFile(path, '{ first');
    await ProfileStore.load(path, fakeLogger(), () => 1);
    await writeFile(path, '{ second');
    await ProfileStore.load(path, fakeLogger(), () => 2);
    expect(await readdir(join(dir, 'data'))).toEqual(['profiles.json.corrupt-2']);
    expect(await readFile(`${path}.corrupt-2`, 'utf8')).toBe('{ second');
  });

  it('notifies listeners only on effective changes', async () => {
    const store = new ProfileStore();
    const listener = vi.fn();
    const unsubscribe = store.onChange(listener);

    await store.setNickname('alice', null); // nothing to clear
    expect(listener).not.toHaveBeenCalled();

    await store.setDiscord('alice', { discordName: 'A', avatarUrl: null });
    await store.setDiscord('alice', { discordName: 'A', avatarUrl: null });
    await store.setNickname('alice', 'Lice');
    await store.setNickname('alice', 'Lice');
    expect(listener.mock.calls).toEqual([['alice'], ['alice']]);

    unsubscribe();
    await store.setNickname('alice', null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns copies, not the stored objects', async () => {
    const store = new ProfileStore();
    const saved = await store.setNickname('alice', 'Lice');
    saved.nickname = 'hacked';
    const read = store.get('alice');
    if (read) read.nickname = 'hacked too';
    expect(store.get('alice')?.nickname).toBe('Lice');
  });
});
