import type { UserInfo } from '@concord/shared';
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../preload/api';
import { ApiClientError, type ApiClient } from './api-client';
import { createSessionManager, NICKNAME_UNSUPPORTED_MESSAGE, sameUser } from './session';
import type { SettingsStore } from './settings';

const bryan: UserInfo = {
  id: 'bryan',
  displayName: 'Bryan',
  admin: false,
  avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png',
  discordName: 'Bryan',
  nickname: null,
};

function fakeSettings(user: UserInfo | null, key: string | null = 'k') {
  let storedUser = user;
  let storedKey = key;
  const store = {
    get: () => ({ serverUrl: 'http://127.0.0.1:3000' }) as Settings,
    update: vi.fn(),
    getKey: () => storedKey,
    setKey: (next: string) => {
      storedKey = next;
    },
    clearKey: () => {
      storedKey = null;
    },
    getUser: () => storedUser,
    setUser: vi.fn((next: UserInfo | null) => {
      storedUser = next;
    }),
  };
  return store as unknown as SettingsStore & { setUser: typeof store.setUser };
}

function fakeClient(overrides: Partial<ApiClient>): ApiClient {
  return {
    me: vi.fn(),
    rooms: vi.fn(),
    token: vi.fn(),
    setNickname: vi.fn(),
    ...overrides,
  } as ApiClient;
}

describe('sameUser', () => {
  it('compares every field the UI shows, treating missing profile fields as null', () => {
    expect(sameUser(null, null)).toBe(true);
    expect(sameUser(bryan, null)).toBe(false);
    expect(sameUser(bryan, { ...bryan })).toBe(true);
    expect(
      sameUser(
        { id: 'bryan', displayName: 'Bryan', admin: false },
        { id: 'bryan', displayName: 'Bryan', admin: false, avatarUrl: null, nickname: null },
      ),
    ).toBe(true);
    expect(sameUser(bryan, { ...bryan, avatarUrl: null })).toBe(false);
    expect(sameUser(bryan, { ...bryan, nickname: 'Bry' })).toBe(false);
    expect(sameUser(bryan, { ...bryan, discordName: 'bryan_' })).toBe(false);
  });
});

describe('session.setNickname', () => {
  it('calls the API, stores the returned user and emits the new session', async () => {
    const updated: UserInfo = { ...bryan, displayName: 'Bry', nickname: 'Bry' };
    const setNickname = vi.fn(async () => updated);
    const settings = fakeSettings(bryan);
    const session = createSessionManager({
      settings,
      createClient: () => fakeClient({ setNickname }),
    });
    const listener = vi.fn();
    session.onChange(listener);

    await expect(session.setNickname('Bry')).resolves.toEqual(updated);
    expect(setNickname).toHaveBeenCalledWith('Bry');
    expect(settings.setUser).toHaveBeenCalledWith(updated);
    expect(listener).toHaveBeenCalledWith({ serverUrl: 'http://127.0.0.1:3000', user: updated });
  });

  it('refuses without a session and keeps the user on API errors', async () => {
    const loggedOut = createSessionManager({
      settings: fakeSettings(null, null),
      createClient: () => fakeClient({}),
    });
    await expect(loggedOut.setNickname('Bry')).rejects.toBeInstanceOf(ApiClientError);

    const settings = fakeSettings(bryan);
    const failing = createSessionManager({
      settings,
      createClient: () =>
        fakeClient({
          setNickname: async () => {
            throw new ApiClientError('http', 'Nome inválido.', 400, 'invalid_nickname');
          },
        }),
    });
    await expect(failing.setNickname('x')).rejects.toThrow('Nome inválido.');
    expect(settings.setUser).not.toHaveBeenCalled();
  });

  it('explains when the server predates the nickname endpoint', async () => {
    const session = createSessionManager({
      settings: fakeSettings(bryan),
      createClient: () =>
        fakeClient({
          setNickname: async () => {
            throw new ApiClientError('http', 'Rota não encontrada.', 404, 'not_found');
          },
        }),
    });
    await expect(session.setNickname('Bry')).rejects.toThrow(NICKNAME_UNSUPPORTED_MESSAGE);
  });
});

describe('session.restore', () => {
  it('emits when only the profile changed (e.g. a new avatar)', async () => {
    const fresh: UserInfo = { ...bryan, avatarUrl: 'https://cdn.discordapp.com/avatars/1/b.png' };
    const session = createSessionManager({
      settings: fakeSettings(bryan),
      createClient: () => fakeClient({ me: async () => fresh }),
    });
    const listener = vi.fn();
    session.onChange(listener);
    await session.restore();
    expect(listener).toHaveBeenCalledTimes(1);

    listener.mockClear();
    await session.restore();
    expect(listener).not.toHaveBeenCalled();
  });
});
