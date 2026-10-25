/**
 * The web session: a `concord_session` cookie the api sets after the Discord login (HttpOnly,
 * so this code never sees it). `GET /api/me` says who is logged in; a 401 anywhere else means
 * the cookie expired (`expire()`). The desktop keeps a key and a user in `settings.json`; the
 * web keeps nothing but the user it last saw, in memory.
 */
import { LOGIN_ERROR_QUERY, type NicknameRequest, type UserInfo } from '@concord/shared';
import type { Session } from '../preload/api';
import type { WebHistory, WebLocation } from './env';
import { ApiClientError, type Http } from './http';
import { log } from './log';
import { parseMe } from './parse';

const logger = log('session');

/** Where "Entrar com Discord" goes: the api starts the OAuth flow and comes back to `/`. */
export const DISCORD_LOGIN_URL = `/api/auth/discord/login?client=web`;

export const NOT_ALLOWLISTED_MESSAGE = 'Esta conta do Discord não está autorizada no Concord.';
export const LOGIN_FAILED_MESSAGE = 'Não foi possível entrar com Discord. Tente de novo.';

/** What `getSession()` rejects with after a failed Discord login (`/?login_error=<code>`). */
export class LoginError extends Error {
  override readonly name = 'LoginError';
  constructor(
    /** The api's error code: `not_allowlisted`, `invalid_oauth_state`, `oauth_exchange_failed`… */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function loginErrorMessage(code: string): string {
  return code === 'not_allowlisted' ? NOT_ALLOWLISTED_MESSAGE : LOGIN_FAILED_MESSAGE;
}

/**
 * The `login_error` code in the page URL, if any, removed from the address bar so a reload or a
 * bookmark does not repeat it.
 */
export function takeLoginError(location: WebLocation, history: WebHistory | null): string | null {
  let url: URL;
  try {
    url = new URL(location.href);
  } catch {
    return null;
  }
  const code = url.searchParams.get(LOGIN_ERROR_QUERY);
  if (code === null) return null;
  url.searchParams.delete(LOGIN_ERROR_QUERY);
  try {
    history?.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (err) {
    logger.warn('could not clean the login error from the URL', err);
  }
  return code;
}

export type SessionListener = (session: Session) => void;

export interface WebSession {
  get(): Session;
  /**
   * The session as the server sees it (`GET /api/me`; 401 = nobody). Rejects with `LoginError`
   * when the page was opened with `?login_error=` (every call in the same tick sees it, so React's
   * StrictMode double mount shows it too; the next tick starts clean).
   */
  getSession(): Promise<Session>;
  /** Navigates to the Discord login; the promise never settles (the page goes away). */
  loginWithDiscord(): Promise<UserInfo>;
  /** `POST /api/auth/logout` (best effort), then nobody is logged in. */
  logout(): Promise<void>;
  /** `PUT /api/me/nickname` (null = back to the Discord name); emits the updated user. */
  setNickname(nickname: string | null): Promise<UserInfo>;
  onChange(listener: SessionListener): () => void;
  /** The server no longer accepts the cookie (401): forget the user and tell listeners. */
  expire(): void;
  /** `GET /api/me` again, quietly: expires the session when the cookie was rejected. */
  revalidate(): Promise<void>;
}

export interface WebSessionOptions {
  http: Http;
  location: WebLocation;
  history: WebHistory | null;
}

export function createWebSession(options: WebSessionOptions): WebSession {
  const { http, location } = options;
  const listeners = new Set<SessionListener>();
  let user: UserInfo | null = null;
  let pendingLoginError = takeLoginError(location, options.history);
  if (pendingLoginError !== null) logger.warn(`Discord login failed: ${pendingLoginError}`);

  function get(): Session {
    return { serverUrl: location.origin, user };
  }

  function emit(): void {
    const session = get();
    for (const listener of listeners) listener(session);
  }

  function setUser(next: UserInfo | null): void {
    user = next;
    emit();
  }

  /** `GET /api/me` without treating a 401 as an expiry: null when nobody is logged in. */
  async function fetchUser(): Promise<UserInfo | null> {
    try {
      return await http.request('/api/me', parseMe, undefined, 'GET', { allowUnauthorized: true });
    } catch (err) {
      if (err instanceof ApiClientError && err.kind === 'unauthorized') return null;
      throw err;
    }
  }

  function expire(): void {
    if (user === null) return;
    logger.warn('session rejected by the server; login required');
    setUser(null);
  }

  return {
    get,
    getSession() {
      if (pendingLoginError !== null) {
        const code = pendingLoginError;
        // Cleared after the current tick, not right away: StrictMode mounts twice in a row and
        // the second mount is the one whose answer the UI keeps.
        queueMicrotask(() => {
          if (pendingLoginError === code) pendingLoginError = null;
        });
        return Promise.reject(new LoginError(code, loginErrorMessage(code)));
      }
      return fetchUser().then((next) => {
        user = next;
        if (user) logger.info(`logged in as ${user.id}`);
        return get();
      });
    },
    loginWithDiscord() {
      pendingLoginError = null;
      logger.info('leaving for the Discord login');
      location.assign(DISCORD_LOGIN_URL);
      return new Promise<UserInfo>(() => undefined);
    },
    async logout() {
      try {
        await http.command('/api/auth/logout', 'POST', undefined, { allowUnauthorized: true });
      } catch (err) {
        // The cookie stays until it expires, but this page forgets the person either way.
        logger.warn('logout request failed; forgetting the session anyway', err);
      }
      logger.info('logged out');
      setUser(null);
    },
    async setNickname(nickname) {
      const body: NicknameRequest = { nickname };
      const next = await http.request('/api/me/nickname', parseMe, body, 'PUT');
      logger.info(`display name of ${next.id} ${nickname === null ? 'reset' : 'changed'}`);
      setUser(next);
      return next;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    expire,
    async revalidate() {
      if (user === null) return;
      try {
        const next = await fetchUser();
        if (next === null) expire();
        else user = next;
      } catch (err) {
        logger.warn('could not revalidate the session; keeping it', err);
      }
    },
  };
}
