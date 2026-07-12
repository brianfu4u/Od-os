/**
 * Sessions for the web clients. Wraps the P1 auth endpoints. In dev/local we sign in via the
 * NODE_ENV-gated mock logins (404 in prod); on staging (NODE_ENV=production) we use the env-gated,
 * password-protected staging logins; in real production the command center uses the manager
 * CREDENTIAL login (login + password). The session TOKEN drives the tenant — the client never sends
 * a self-reported tenant for data. Tokens persist through the never-throws safe-storage. The manager
 * (command center) and staff (terminal) tokens use SEPARATE keys so both can be used in one browser.
 */
import { API_BASE } from './config';
import { safeStorage } from './safe-storage';

export const SESSION_KEY = 'cv_session_token';
/** T1: the staff terminal persists its session separately from the manager's. */
export const STAFF_SESSION_KEY = 'cv_staff_token';

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

async function post(path: string, payload: Record<string, unknown>): Promise<Session> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Session;
}

// ── Manager (command center) ────────────────────────────────────────────────
/** PROD manager login: real credential (login + password). Tenant + role come from the server. */
export function managerLogin(login: string, password: string): Promise<Session> {
  return post('/auth/manager/login', { login, password });
}
/** Dev-gated mock manager login → issues a session bound to {tenant, role}. */
export function managerDevLogin(tenantId: string, login: string, displayName?: string): Promise<Session> {
  return post('/auth/manager/dev-login', { tenantId, login, displayName });
}
/** Minimal-secure STAGING manager login (tenant comes from the server env). */
export function managerStagingLogin(password: string): Promise<Session> {
  return post('/auth/manager/staging-login', { password });
}

// ── Staff (terminal) — T1 ─────────────────────────────────────────────────────
/** Dev-gated mock staff login → issues a staff session bound to {tenant, staff}. */
export function staffDevLogin(tenantId: string, handle: string, displayName?: string): Promise<Session> {
  return post('/auth/staff/dev-login', { tenantId, handle, displayName });
}
/** STAGING staff login (password-gated); tenant from server env, staff provisioned by handle. */
export function staffStagingLogin(password: string, handle: string, displayName?: string): Promise<Session> {
  return post('/auth/staff/staging-login', { password, handle, displayName });
}

/** Resolve the identity for a token (validates a stored session on reload). */
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

// Manager token helpers (command center).
export function loadToken(): string | null {
  return safeStorage.get(SESSION_KEY);
}
export function saveToken(token: string): void {
  safeStorage.set(SESSION_KEY, token);
}
export function clearToken(): void {
  safeStorage.remove(SESSION_KEY);
}

// Staff token helpers (terminal).
export function loadStaffToken(): string | null {
  return safeStorage.get(STAFF_SESSION_KEY);
}
export function saveStaffToken(token: string): void {
  safeStorage.set(STAFF_SESSION_KEY, token);
}
export function clearStaffToken(): void {
  safeStorage.remove(STAFF_SESSION_KEY);
}
