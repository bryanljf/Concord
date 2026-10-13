import { useCallback, useEffect, useRef, useState } from 'react';
import type { UserInfo } from '@concord/shared';
import { concord, toErrorMessage } from '../lib/concord';
import { sameUser } from '../lib/user';

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
  loginWithDiscord(serverUrl: string): Promise<UserInfo>;
  /** Changes the display name (null = Discord name); rejects with a pt-BR message. */
  setNickname(nickname: string | null): Promise<UserInfo>;
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
    concord()
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
  // revalidation that rejected the stored key, profile changes such as a new nickname). Our own
  // login/logout calls are ignored here.
  useEffect(
    () =>
      concord().onSessionChanged((session) => {
        if (localLogin.current) return;
        setState((prev) => {
          if (sameUser(prev.user, session.user) && prev.serverUrl === session.serverUrl) {
            return prev;
          }
          // Same person with a new name/avatar: refresh the profile, keep the onboarding state.
          if (prev.user && session.user && prev.user.id === session.user.id) {
            return { ...prev, serverUrl: session.serverUrl, user: session.user };
          }
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
      const user = await concord().login(serverUrl, key);
      setState((prev) => ({ ...prev, serverUrl, user, error: null }));
      return user;
    } finally {
      localLogin.current = false;
    }
  }, []);

  const loginWithDiscord = useCallback(async (serverUrl: string) => {
    localLogin.current = true;
    try {
      const user = await concord().loginWithDiscord(serverUrl);
      setState((prev) => ({ ...prev, serverUrl, user, error: null }));
      return user;
    } finally {
      localLogin.current = false;
    }
  }, []);

  const setNickname = useCallback(async (nickname: string | null) => {
    const user = await concord().setNickname(nickname);
    // Main also pushes the change; applying it here avoids waiting for the round trip.
    setState((prev) => (prev.user && prev.user.id === user.id ? { ...prev, user } : prev));
    return user;
  }, []);

  const finishOnboarding = useCallback(() => {
    setState((prev) => ({ ...prev, onboarding: 'none' }));
  }, []);

  const logout = useCallback(async () => {
    await concord().logout();
    setState((prev) => ({ ...prev, user: null, onboarding: 'full' }));
  }, []);

  const startRekey = useCallback(async () => {
    await concord().logout();
    setState((prev) => ({ ...prev, user: null, onboarding: 'rekey' }));
  }, []);

  return {
    ...state,
    login,
    loginWithDiscord,
    setNickname,
    finishOnboarding,
    logout,
    startRekey,
  };
}
