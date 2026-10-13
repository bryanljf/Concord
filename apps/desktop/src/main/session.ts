import type { UserInfo } from '@concord/shared';
import type { Session } from '../preload/api';
import {
  ApiClientError,
  normalizeServerUrl,
  type ApiClient,
  type ApiClientOptions,
} from './api-client';
import { log } from './log';
import type { SettingsStore } from './settings';

const logger = log('session');

export const NICKNAME_UNSUPPORTED_MESSAGE =
  'Este servidor ainda não permite trocar o nome. Peça para atualizarem o concord-api.';

function isMissingRoute(err: unknown): boolean {
  return (
    err instanceof ApiClientError &&
    err.status === 404 &&
    (err.code === undefined || err.code === 'not_found')
  );
}

export type SessionListener = (session: Session) => void;

export interface SessionManager {
  get(): Session;
  /** True when both a key and a user are stored (presence may connect). */
  isAuthenticated(): boolean;
  /** Validates the key against `GET /api/me`, then stores server URL, key and user. */
  login(serverUrl: string, key: string): Promise<UserInfo>;
  loginWithDiscord(serverUrl: string): Promise<UserInfo>;
  logout(): Promise<void>;
  /** `PUT /api/me/nickname` (null = back to the Discord name); stores the user and emits. */
  setNickname(nickname: string | null): Promise<UserInfo>;
  /** Revalidates a stored key in the background; keeps the session when the server is unreachable. */
  restore(): Promise<void>;
  onChange(listener: SessionListener): () => void;
}

export interface SessionManagerDeps {
  settings: SettingsStore;
  createClient(options: ApiClientOptions): ApiClient;
  openDiscordLogin?(serverUrl: string): Promise<string>;
}

/** True when every field shown in the UI (name, avatar, Discord name, nickname, admin) matches. */
export function sameUser(a: UserInfo | null, b: UserInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.admin === b.admin &&
    (a.avatarUrl ?? null) === (b.avatarUrl ?? null) &&
    (a.discordName ?? null) === (b.discordName ?? null) &&
    (a.nickname ?? null) === (b.nickname ?? null)
  );
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { settings } = deps;
  const listeners = new Set<SessionListener>();

  /** Client bound to the stored server URL and key. */
  function storedClient(): ApiClient {
    return deps.createClient({
      getServerUrl: () => settings.get().serverUrl,
      getKey: () => settings.getKey(),
    });
  }

  function get(): Session {
    const user = settings.getKey() === null ? null : settings.getUser();
    return { serverUrl: settings.get().serverUrl, user };
  }

  function emit(): void {
    const session = get();
    for (const listener of listeners) listener(session);
  }

  return {
    get,
    isAuthenticated: () => get().user !== null,
    async login(serverUrl, key) {
      const base = normalizeServerUrl(serverUrl);
      const trimmedKey = key.trim();
      if (trimmedKey === '') throw new ApiClientError('no_key', 'Informe a chave de acesso.');
      const client = deps.createClient({ getServerUrl: () => base, getKey: () => trimmedKey });
      const user = await client.me();
      settings.setKey(trimmedKey);
      settings.setUser(user);
      if (settings.get().serverUrl !== base) settings.update({ serverUrl: base });
      logger.info(`logged in as ${user.id} on ${base}`);
      emit();
      return user;
    },
    async loginWithDiscord(serverUrl) {
      if (!deps.openDiscordLogin)
        throw new ApiClientError('network', 'Login com Discord indisponível.');
      const base = normalizeServerUrl(serverUrl);
      const credential = await deps.openDiscordLogin(base);
      // The OAuth callback only hands over the credential: the full profile (avatar, Discord
      // name, nickname) always comes from `/api/me`.
      const client = deps.createClient({ getServerUrl: () => base, getKey: () => credential });
      const user = await client.me();
      settings.setKey(credential);
      settings.setUser(user);
      if (settings.get().serverUrl !== base) settings.update({ serverUrl: base });
      logger.info(`logged in with Discord as ${user.id} on ${base}`);
      emit();
      return user;
    },
    async logout() {
      settings.clearKey();
      settings.setUser(null);
      logger.info('logged out');
      emit();
    },
    async setNickname(nickname) {
      if (settings.getKey() === null || settings.getUser() === null) {
        throw new ApiClientError('no_key', 'Entre na sua conta antes de alterar o nome.');
      }
      let user: UserInfo;
      try {
        user = await storedClient().setNickname(nickname);
      } catch (err) {
        // A concord-api from before this feature has no such route (404 `not_found`).
        if (isMissingRoute(err)) {
          throw new ApiClientError('http', NICKNAME_UNSUPPORTED_MESSAGE, 404);
        }
        throw err;
      }
      settings.setUser(user);
      logger.info(`display name of ${user.id} ${nickname === null ? 'reset' : 'changed'}`);
      emit();
      return user;
    },
    async restore() {
      if (settings.getKey() === null) {
        logger.info('no stored key; onboarding required');
        return;
      }
      try {
        const user = await storedClient().me();
        const previous = settings.getUser();
        settings.setUser(user);
        logger.info(`session restored for ${user.id}`);
        if (!sameUser(previous, user)) emit();
      } catch (err) {
        if (err instanceof ApiClientError && err.kind === 'unauthorized') {
          logger.warn('stored key rejected by the server; onboarding required');
          settings.setUser(null);
          emit();
          return;
        }
        logger.warn('could not revalidate the session; keeping the stored user', err);
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
