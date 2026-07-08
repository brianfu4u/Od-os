import { Injectable } from '@nestjs/common';
import { getPool } from '../database/pool';
import type { ManagerIdentityRow, SessionRow, StaffIdentityRow } from './session.types';

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
        `INSERT INTO sessions (token, subject, tenant_id, staff_id, manager_id, role, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.token, row.subject, row.tenantId, row.staffId ?? null, row.managerId ?? null, row.role ?? null, row.expiresAt.toISOString()],
      );
    } finally {
      c.release();
    }
  }

  /** Returns the session only if it exists AND is unexpired. */
  async getValidSession(token: string): Promise<SessionRow | null> {
    const c = await getPool().connect();
    try {
      const res = await c.query<SessionRow>(
        `SELECT token, subject, tenant_id, staff_id, manager_id, role, expires_at
           FROM sessions WHERE token = $1 AND expires_at > now() LIMIT 1`,
        [token],
      );
      return res.rows[0] ?? null;
    } finally {
      c.release();
    }
  }

  async deleteSession(token: string): Promise<void> {
    const c = await getPool().connect();
    try {
      await c.query(`DELETE FROM sessions WHERE token = $1`, [token]);
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
        `SELECT login, tenant_id, manager_id, role FROM manager_identities WHERE login = $1 LIMIT 1`,
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
}
