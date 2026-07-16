/**
 * Sessions for the web clients. Wraps the P1 auth endpoints. In dev/local we sign in via the
 * NODE_ENV-gated mock logins (404 in prod); on staging (NODE_ENV=production) we use the env-gated,
 * password-protected staging logins; in real production the command center uses the manager
 * CREDENTIAL login (login + password). The session TOKEN drives the tenant — the client never sends
 * a self-reported tenant for data.
 *
 * P0-2 sub-issue 2: the token is delivered as an HttpOnly cookie (set by the API, `credentials:
 * 'include'` below) and is NEVER persisted to JS-readable storage, so an XSS cannot steal it. On
 * reload the session is rehydrated by calling `/auth/me` with the cookie. NOTE: a browser holds a
 * SINGLE `cv_session` cookie, so the manager (command center) and staff (terminal) can no longer be
 * signed in SIMULTANEOUSLY in one browser — the most recent login wins. This is acceptable for the
 * pilot (the two surfaces run on separate devices); see the PR for the follow-up options.
 */
import { API_BASE } from './config';

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
    credentials: 'include', // accept the Set-Cookie session the API returns
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

/** Resolve the current identity from the session COOKIE (rehydrates a session on reload). */
export async function fetchMe(): Promise<SessionIdentity | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'include' });
    if (!res.ok) return null;
    return (await res.json()) as SessionIdentity;
  } catch {
    return null;
  }
}

/** Best-effort logout: the API clears the HttpOnly cookie (Max-Age=0) for the caller. */
export async function serverLogout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
  } catch {
    /* best-effort */
  }
}
