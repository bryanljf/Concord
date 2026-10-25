import type { UserInfo } from '@concord/shared';
import { describe, expect, it } from 'vitest';
import type { Session } from '../preload/api';
import {
  emptyResponse,
  fakeHistory,
  fakeLocation,
  jsonResponse,
  scriptedFetch,
  type FetchHandler,
} from './fakes';
import { createHttp, networkErrorMessage, SESSION_EXPIRED_MESSAGE } from './http';
import {
  createWebSession,
  DISCORD_LOGIN_URL,
  LOGIN_FAILED_MESSAGE,
  loginErrorMessage,
  NOT_ALLOWLISTED_MESSAGE,
  takeLoginError,
} from './session';

const USER: UserInfo = {
  id: 'ana',
  displayName: 'Ana',
  admin: false,
  avatarUrl: null,
  discordName: null,
  nickname: null,
};

function setup(handler: FetchHandler, href = 'http://localhost/') {
  const location = fakeLocation(href);
  const history = fakeHistory();
  const { fetchImpl, calls } = scriptedFetch(handler);
  const changes: Session[] = [];
  const http = createHttp({ host: location.host, fetchImpl });
  const session = createWebSession({ http, location, history });
  session.onChange((next) => changes.push(next));
  return { session, location, history, calls, changes };
}

const meOk: FetchHandler = (path) =>
  path === '/api/me' ? jsonResponse(200, { user: USER }) : emptyResponse(404);

describe('takeLoginError', () => {
  it('reads the code and removes only that parameter from the address bar', () => {
    const location = fakeLocation('http://localhost/?login_error=not_allowlisted&x=1#top');
    const history = fakeHistory();
    expect(takeLoginError(location, history)).toBe('not_allowlisted');
    expect(history.replaced).toEqual(['/?x=1#top']);
  });

  it('is null without the parameter and touches nothing', () => {
    const history = fakeHistory();
    expect(takeLoginError(fakeLocation('http://localhost/?x=1'), history)).toBeNull();
    expect(history.replaced).toEqual([]);
    expect(takeLoginError(fakeLocation('http://localhost/?login_error=x'), null)).toBe('x');
  });
});

describe('loginErrorMessage', () => {
  it('names the allowlist, everything else is a generic failure', () => {
    expect(loginErrorMessage('not_allowlisted')).toBe(NOT_ALLOWLISTED_MESSAGE);
    expect(loginErrorMessage('invalid_oauth_state')).toBe(LOGIN_FAILED_MESSAGE);
    expect(loginErrorMessage('oauth_exchange_failed')).toBe(LOGIN_FAILED_MESSAGE);
  });
});

describe('getSession', () => {
  it('resolves the user from GET /api/me with the session cookie', async () => {
    const { session, calls } = setup(meOk);
    await expect(session.getSession()).resolves.toEqual({
      serverUrl: 'http://localhost',
      user: USER,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/api/me');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(session.get().user).toEqual(USER);
  });

  it('is nobody on a 401 (no error, no change emitted)', async () => {
    const { session, changes } = setup(() => jsonResponse(401, { error: 'unauthorized' }));
    await expect(session.getSession()).resolves.toEqual({
      serverUrl: 'http://localhost',
      user: null,
    });
    expect(changes).toEqual([]);
  });

  it('rejects with the network message when the api is unreachable', async () => {
    const { session } = setup(() => {
      throw new TypeError('fetch failed');
    });
    await expect(session.getSession()).rejects.toMatchObject({
      message: networkErrorMessage('localhost'),
    });
  });

  it('rejects once per tick with the login error from the URL, then starts clean', async () => {
    const { session, history } = setup(
      () => jsonResponse(401, {}),
      'http://localhost/?login_error=not_allowlisted',
    );
    expect(history.replaced).toEqual(['/']);
    // StrictMode mounts twice in the same tick: both must see the error.
    const first = session.getSession();
    const second = session.getSession();
    await expect(first).rejects.toMatchObject({
      name: 'LoginError',
      code: 'not_allowlisted',
      message: NOT_ALLOWLISTED_MESSAGE,
    });
    await expect(second).rejects.toMatchObject({ code: 'not_allowlisted' });
    await expect(session.getSession()).resolves.toEqual({
      serverUrl: 'http://localhost',
      user: null,
    });
  });

  it('uses the generic message for the other codes', async () => {
    const { session } = setup(meOk, 'http://localhost/?login_error=oauth_identify_failed');
    await expect(session.getSession()).rejects.toMatchObject({ message: LOGIN_FAILED_MESSAGE });
  });
});

describe('loginWithDiscord', () => {
  it('navigates to the web login and never settles', async () => {
    const { session, location } = setup(meOk);
    const pending = session.loginWithDiscord();
    expect(location.assigned).toEqual([DISCORD_LOGIN_URL]);
    const outcome = await Promise.race([
      pending.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    expect(outcome).toBe('pending');
  });

  it('drops a pending login error (the person is trying again)', async () => {
    const { session } = setup(meOk, 'http://localhost/?login_error=not_allowlisted');
    void session.loginWithDiscord();
    await expect(session.getSession()).resolves.toMatchObject({ user: USER });
  });
});

describe('logout', () => {
  it('posts to /api/auth/logout and emits nobody', async () => {
    const { session, calls, changes } = setup((path) =>
      path === '/api/me' ? jsonResponse(200, { user: USER }) : emptyResponse(204),
    );
    await session.getSession();
    await session.logout();
    expect(calls[1]).toMatchObject({ path: '/api/auth/logout', init: { method: 'POST' } });
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
    expect(session.get().user).toBeNull();
  });

  it('forgets the person even when the request fails', async () => {
    const { session, changes } = setup((path) => {
      if (path === '/api/me') return jsonResponse(200, { user: USER });
      throw new TypeError('offline');
    });
    await session.getSession();
    await expect(session.logout()).resolves.toBeUndefined();
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
  });
});

describe('setNickname', () => {
  it('PUTs the nickname and emits the updated user', async () => {
    const renamed = { ...USER, displayName: 'Aninha', nickname: 'Aninha' };
    const { session, calls, changes } = setup((path, init) =>
      path === '/api/me/nickname' && init?.method === 'PUT'
        ? jsonResponse(200, { user: renamed })
        : jsonResponse(200, { user: USER }),
    );
    await session.getSession();
    await expect(session.setNickname('Aninha')).resolves.toEqual(renamed);
    expect(calls[1]?.json).toEqual({ nickname: 'Aninha' });
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: renamed }]);
  });

  it('surfaces the server message', async () => {
    const { session } = setup((path) =>
      path === '/api/me/nickname'
        ? jsonResponse(400, { error: 'invalid_nickname', message: 'Nome inválido.' })
        : jsonResponse(200, { user: USER }),
    );
    await expect(session.setNickname('x'.repeat(99))).rejects.toMatchObject({
      message: 'Nome inválido.',
      code: 'invalid_nickname',
    });
  });
});

describe('expire and revalidate', () => {
  it('expire emits nobody once', async () => {
    const { session, changes } = setup(meOk);
    await session.getSession();
    session.expire();
    session.expire();
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
  });

  it('revalidate expires the session when the cookie is rejected, keeps it otherwise', async () => {
    let status = 200;
    const { session, changes } = setup(() =>
      status === 200 ? jsonResponse(200, { user: USER }) : jsonResponse(401, {}),
    );
    await session.getSession();
    await session.revalidate();
    expect(changes).toEqual([]);
    status = 401;
    await session.revalidate();
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
    // Nobody logged in: nothing to check.
    await session.revalidate();
    expect(changes).toHaveLength(1);
  });

  it('a 401 on an authenticated call (through the http hook) is the session expiring', async () => {
    const location = fakeLocation();
    const { fetchImpl } = scriptedFetch((path) =>
      path === '/api/me' ? jsonResponse(200, { user: USER }) : jsonResponse(401, {}),
    );
    const http = createHttp({ host: location.host, fetchImpl, onUnauthorized: () => expire() });
    const session = createWebSession({ http, location, history: null });
    const expire = (): void => session.expire();
    const changes: Session[] = [];
    session.onChange((next) => changes.push(next));
    await session.getSession();
    await expect(http.request('/api/rooms', () => null)).rejects.toMatchObject({
      kind: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(changes).toEqual([{ serverUrl: 'http://localhost', user: null }]);
  });
});
