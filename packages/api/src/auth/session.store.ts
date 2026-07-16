import { Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getPool } from '../database/pool';
import type { ManagerIdentityRow, SessionRow, StaffIdentityRow } from './session.types';

/**
 * P0-2 sub-issue 1: the `sessions` table stores ONLY a SHA-256 hash of the opaque token, never the
 * raw token. A DB leak therefore yields hashes, not live bearer credentials. SHA-256 (not scrypt) is
 * correct here: the token is a 256-bit CSPRNG value with full entropy, so it is not brute-forceable
 * and needs no slow KDF — a fast one-way hash is enough and keeps lookups a single indexed equality.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time compare of two hex hashes of equal length (guards the final match, defense-in-depth). */
function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Raw data access for the NON-tenant auth tables (sessions, staff_identities, manager_identities).
 *
 * These run on the base `clearview_login` role WITHOUT `SET LOCAL ROLE clearview_app` and WITHOUT
 * a tenant GUC — because identity/session lookup must happen BEFORE a tenant is known (the session
 * is what tells us the tenant). The tables have no RLS and are granted directly to clearview_login,
 * so this is the ONLY sanctioned path that reads them; all business/ontology data still flows
 * exclusively through withTenant().
 */
@Injectable()
export class SessionStore {
  async createSession(row: {
    token: string;
    subject: 'staff' | 'manager';
    tenantId: string;
    staffId?: string;
    managerId?: string;
    role?: string;
    expiresAt: Date;
  }): Promise<void> {
    const c = await getPool().connect();
    try {
      await c.query(
        `INSERT INTO sessions (token_hash, subject, tenant_id, staff_id, manager_id, role, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [hashToken(row.token), row.subject, row.tenantId, row.staffId ?? null, row.managerId ?? null, row.role ?? null, row.expiresAt.toISOString()],
      );
    } finally {
      c.release();
    }
  }

  /**
   * Returns the session only if it exists AND is unexpired. The caller passes the RAW token; we hash
   * it and look it up by hash (the raw token is never stored). A final constant-time hash compare
   * guards the match.
   */
  async getValidSession(token: string): Promise<SessionRow | null> {
    const tokenHash = hashToken(token);
    const c = await getPool().connect();
    try {
      const res = await c.query<SessionRow>(
        `SELECT token_hash, subject, tenant_id, staff_id, manager_id, role, expires_at
           FROM sessions WHERE token_hash = $1 AND expires_at > now() LIMIT 1`,
        [tokenHash],
      );
      const row = res.rows[0];
      if (!row || !hashesEqual(row.token_hash, tokenHash)) return null;
      return row;
    } finally {
      c.release();
    }
  }

  async deleteSession(token: string): Promise<void> {
    const c = await getPool().connect();
    try {
      await c.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
    } finally {
      c.release();
    }
  }

  async findStaffIdentity(openid: string): Promise<StaffIdentityRow | null> {
    const c = await getPool().connect();
    try {
      const res = await c.query<StaffIdentityRow>(
        `SELECT openid, tenant_id, staff_id, display_name FROM staff_identities WHERE openid = $1 LIMIT 1`,
        [openid],
      );
      return res.rows[0] ?? null;
    } finally {
      c.release();
    }
  }

  async upsertStaffIdentity(row: { openid: string; tenantId: string; staffId: string; displayName?: string }): Promise<void> {
    const c = await getPool().connect();
    try {
      await c.query(
        `INSERT INTO staff_identities (openid, tenant_id, staff_id, display_name)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (openid) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, staff_id = EXCLUDED.staff_id, display_name = EXCLUDED.display_name`,
        [row.openid, row.tenantId, row.staffId, row.displayName ?? null],
      );
    } finally {
      c.release();
    }
  }

  async findManagerIdentity(login: string): Promise<ManagerIdentityRow | null> {
    const c = await getPool().connect();
    try {
      const res = await c.query<ManagerIdentityRow>(
        `SELECT login, tenant_id, manager_id, role, password_hash FROM manager_identities WHERE login = $1 LIMIT 1`,
        [login],
      );
      return res.rows[0] ?? null;
    } finally {
      c.release();
    }
  }

  async upsertManagerIdentity(row: { login: string; tenantId: string; managerId: string; role: string }): Promise<void> {
    const c = await getPool().connect();
    try {
      await c.query(
        `INSERT INTO manager_identities (login, tenant_id, manager_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (login) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, manager_id = EXCLUDED.manager_id, role = EXCLUDED.role`,
        [row.login, row.tenantId, row.managerId, row.role],
      );
    } finally {
      c.release();
    }
  }

  /**
   * Set/rotate a manager's credential hash (0012). Stores ONLY the scrypt-encoded hash, never a
   * plaintext password, and stamps password_updated_at. Uses the same clearview_login UPDATE grant
   * as upsertManagerIdentity — no new privilege.
   */
  async setManagerPassword(login: string, passwordHash: string): Promise<void> {
    const c = await getPool().connect();
    try {
      await c.query(
        `UPDATE manager_identities SET password_hash = $2, password_updated_at = now() WHERE login = $1`,
        [login, passwordHash],
      );
    } finally {
      c.release();
    }
  }
}
