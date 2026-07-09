/**
 * Manager session for the command center (P3). Wraps the P1 auth endpoints. In dev/local we sign in
 * via the NODE_ENV-gated mock `/auth/manager/dev-login` (404 in prod); production replaces this with
 * a real magic-link / SSO login (TODO). The session TOKEN drives the tenant — the client never sends
 * a self-reported tenant for data. The token is persisted through the never-throws safe-storage.
 */
import { API_BASE } from './config';
import { safeStorage } from './safe-storage';

export const SESSION_KEY = 'cv_session_token';

export interface SessionIdentity {
  subject: 'staff' | 'manager' | 'dev';
  tenantId: string;
  staffId?: string;
  managerId?: string;
  role?: string;
  displayName?: string;
}

export interface Session {
  token: string;
  identity: SessionIdentity;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (body?.message) return Array.isArray(body.message) ? body.message.join(', ') : body.message;
  } catch {
    /* non-JSON */
  }
  return res.statusText || `HTTP ${res.status}`;
}

/** Dev-gated mock manager login → issues a session bound to {tenant, role}. */
export async function managerDevLogin(tenantId: string, login: string, displayName?: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/auth/manager/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenantId, login, displayName }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as Session;
  return data;
}

/** Minimal-secure STAGING login → issues a manager session (tenant comes from the server env). */
export async function managerStagingLogin(password: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/auth/manager/staging-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Session;
}

/** Resolve the identity for a token (validates the stored session on reload). */
export async function fetchMe(token: string): Promise<SessionIdentity | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as SessionIdentity;
  } catch {
    return null;
  }
}

export async function serverLogout(token: string): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    /* best-effort */
  }
}

export function loadToken(): string | null {
  return safeStorage.get(SESSION_KEY);
}
export function saveToken(token: string): void {
  safeStorage.set(SESSION_KEY, token);
}
export function clearToken(): void {
  safeStorage.remove(SESSION_KEY);
}
