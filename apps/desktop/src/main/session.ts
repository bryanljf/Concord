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

export type SessionListener = (session: Session) => void;

export interface SessionManager {
  get(): Session;
  /** True when both a key and a user are stored (presence may connect). */
  isAuthenticated(): boolean;
  /** Validates the key against `GET /api/me`, then stores server URL, key and user. */
  login(serverUrl: string, key: string): Promise<UserInfo>;
  logout(): Promise<void>;
  /** Revalidates a stored key in the background; keeps the session when the server is unreachable. */
  restore(): Promise<void>;
  onChange(listener: SessionListener): () => void;
}

export interface SessionManagerDeps {
  settings: SettingsStore;
  createClient(options: ApiClientOptions): ApiClient;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { settings } = deps;
  const listeners = new Set<SessionListener>();

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
    async logout() {
      settings.clearKey();
      settings.setUser(null);
      logger.info('logged out');
      emit();
    },
    async restore() {
      if (settings.getKey() === null) {
        logger.info('no stored key; onboarding required');
        return;
      }
      const client = deps.createClient({
        getServerUrl: () => settings.get().serverUrl,
        getKey: () => settings.getKey(),
      });
      try {
        const user = await client.me();
        const previous = settings.getUser();
        settings.setUser(user);
        logger.info(`session restored for ${user.id}`);
        if (!previous || previous.id !== user.id || previous.displayName !== user.displayName) {
          emit();
        }
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
