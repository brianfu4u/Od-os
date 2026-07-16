'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { makeApi, type Api } from '../../lib/api';
import {
  fetchMe,
  managerDevLogin,
  managerLogin,
  managerStagingLogin,
  serverLogout,
  type Session,
} from '../../lib/session';

interface SessionContextValue {
  session: Session | null;
  /** True once we've finished hydrating any stored token (avoids a login flash on reload). */
  ready: boolean;
  storageAvailable: boolean;
  login: (tenantId: string, login: string, displayName?: string) => Promise<void>;
  /** P5 staging: password-gated manager login (tenant decided server-side). */
  stagingLogin: (password: string) => Promise<void>;
  /** Production: real manager credential login (login + password; tenant + role from the server). */
  credentialLogin: (login: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  // Cookie auth no longer depends on JS storage, so storage is never a blocker for sign-in.
  const storageAvailable = true;

  // Rehydrate the session from the HttpOnly cookie via /auth/me (client-only → static prerender safe).
  useEffect(() => {
    let cancelled = false;
    void fetchMe().then((identity) => {
      if (cancelled) return;
      if (identity) setSession({ token: '', identity });
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (tenantId: string, loginName: string, displayName?: string) => {
    setSession(await managerDevLogin(tenantId, loginName, displayName));
  }, []);

  const stagingLogin = useCallback(async (password: string) => {
    setSession(await managerStagingLogin(password));
  }, []);

  const credentialLogin = useCallback(async (loginId: string, password: string) => {
    setSession(await managerLogin(loginId, password));
  }, []);

  const logout = useCallback(async () => {
    setSession(null);
    await serverLogout();
  }, []);

  const value = useMemo<SessionContextValue>(
    () => ({ session, ready, storageAvailable, login, stagingLogin, credentialLogin, logout }),
    [session, ready, storageAvailable, login, stagingLogin, credentialLogin, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}

/** The API client bound to the current session token — null until the manager has logged in. */
export function useSessionApi(): Api | null {
  const { session } = useSession();
  return useMemo(() => (session ? makeApi({ token: session.token }) : null), [session]);
}
