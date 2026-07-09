'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { makeApi, type Api } from '../../lib/api';
import {
  clearToken,
  fetchMe,
  loadToken,
  managerDevLogin,
  saveToken,
  serverLogout,
  type Session,
} from '../../lib/session';
import { safeStorage } from '../../lib/safe-storage';

interface SessionContextValue {
  session: Session | null;
  /** True once we've finished hydrating any stored token (avoids a login flash on reload). */
  ready: boolean;
  storageAvailable: boolean;
  login: (tenantId: string, login: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);

  // Hydrate a stored token on mount and validate it via /auth/me (client-only → static prerender safe).
  useEffect(() => {
    setStorageAvailable(safeStorage.isAvailable());
    const token = loadToken();
    if (!token) {
      setReady(true);
      return;
    }
    let cancelled = false;
    void fetchMe(token).then((identity) => {
      if (cancelled) return;
      if (identity) setSession({ token, identity });
      else clearToken();
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (tenantId: string, loginName: string, displayName?: string) => {
    const s = await managerDevLogin(tenantId, loginName, displayName);
    saveToken(s.token);
    setSession(s);
  }, []);

  const logout = useCallback(async () => {
    const current = session;
    setSession(null);
    clearToken();
    if (current) await serverLogout(current.token);
  }, [session]);

  const value = useMemo<SessionContextValue>(
    () => ({ session, ready, storageAvailable, login, logout }),
    [session, ready, storageAvailable, login, logout],
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
