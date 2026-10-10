import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserInfo } from '@telao/shared';
import { telao, toErrorMessage } from '../lib/telao';

/** Which onboarding flow (if any) must be shown before the main UI. */
export type OnboardingMode = 'none' | 'full' | 'rekey';

interface SessionState {
  loading: boolean;
  serverUrl: string;
  user: UserInfo | null;
  onboarding: OnboardingMode;
  /** Only set when the session itself could not be loaded (bridge/IPC failure). */
  error: string | null;
}

export interface UseSession extends SessionState {
  /** Validates the key with the server and stores it; rejects with a pt-BR message. */
  login(serverUrl: string, key: string): Promise<UserInfo>;
  /** Marks the onboarding flow as done so the main UI can show. */
  finishOnboarding(): void;
  /** Clears the stored key and restarts the full onboarding. */
  logout(): Promise<void>;
  /** Clears the stored key and reopens onboarding at the access-key step. */
  startRekey(): Promise<void>;
}

const INITIAL: SessionState = {
  loading: true,
  serverUrl: '',
  user: null,
  onboarding: 'full',
  error: null,
};

export function useSession(): UseSession {
  const [state, setState] = useState<SessionState>(INITIAL);
  // True while this renderer's own `login` call is in flight: the session-changed push it
  // triggers must not skip the remaining onboarding steps.
  const localLogin = useRef(false);

  useEffect(() => {
    let active = true;
    telao()
      .getSession()
      .then(
        (session) => {
          if (!active) return;
          setState({
            loading: false,
            serverUrl: session.serverUrl,
            user: session.user,
            onboarding: session.user ? 'none' : 'full',
            error: null,
          });
        },
        (err: unknown) => {
          if (!active) return;
          setState((prev) => ({ ...prev, loading: false, error: toErrorMessage(err) }));
        },
      );
    return () => {
      active = false;
    };
  }, []);

  // Pushed by main after a login/logout it performed itself (dev flags, background
  // revalidation that rejected the stored key). Our own login/logout calls are ignored here.
  useEffect(
    () =>
      telao().onSessionChanged((session) => {
        if (localLogin.current) return;
        setState((prev) => {
          const sameUser =
            prev.user?.id === session.user?.id &&
            prev.user?.displayName === session.user?.displayName;
          if (sameUser && prev.serverUrl === session.serverUrl) return prev;
          return {
            ...prev,
            serverUrl: session.serverUrl,
            user: session.user,
            onboarding: session.user ? 'none' : 'full',
            error: null,
          };
        });
      }),
    [],
  );

  const login = useCallback(async (serverUrl: string, key: string) => {
    localLogin.current = true;
    try {
      const user = await telao().login(serverUrl, key);
      setState((prev) => ({ ...prev, serverUrl, user, error: null }));
      return user;
    } finally {
      localLogin.current = false;
    }
  }, []);

  const finishOnboarding = useCallback(() => {
    setState((prev) => ({ ...prev, onboarding: 'none' }));
  }, []);

  const logout = useCallback(async () => {
    await telao().logout();
    setState((prev) => ({ ...prev, user: null, onboarding: 'full' }));
  }, []);

  const startRekey = useCallback(async () => {
    await telao().logout();
    setState((prev) => ({ ...prev, user: null, onboarding: 'rekey' }));
  }, []);

  return { ...state, login, finishOnboarding, logout, startRekey };
}
