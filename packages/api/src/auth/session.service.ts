import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { withTenant } from '../database/tenant-context';
import { SessionStore } from './session.store';
import type { SessionIdentity } from './session.types';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

@Injectable()
export class SessionService {
  constructor(private readonly store: SessionStore) {}

  private newToken(): string {
    return randomBytes(32).toString('hex');
  }

  /** Resolve an opaque session token to a caller identity, or null if missing/expired. */
  async resolve(token: string): Promise<SessionIdentity | null> {
    const s = await this.store.getValidSession(token);
    if (!s) return null;
    return {
      subject: s.subject,
      tenantId: s.tenant_id,
      staffId: s.staff_id ?? undefined,
      managerId: s.manager_id ?? undefined,
      role: s.role ?? undefined,
    };
  }

  async logout(token: string): Promise<void> {
    await this.store.deleteSession(token);
  }

  /**
   * PROD staff path: a resolved WeChat openid must already map to a {tenant, staff}. Staff are
   * registered by a manager/admin (or, in dev, by dev-login) — an unknown openid cannot
   * self-assign a tenant. Returns a session token.
   */
  async issueStaffByOpenid(openid: string): Promise<{ token: string; identity: SessionIdentity }> {
    const idn = await this.store.findStaffIdentity(openid);
    if (!idn) {
      throw new UnauthorizedException('This WeChat account is not registered as staff for any clinic.');
    }
    return this.issue('staff', { tenantId: idn.tenant_id, staffId: idn.staff_id });
  }

  /**
   * DEV-ONLY mock of the wx.login → session flow: provisions (idempotently) the Staff object +
   * the openid→staff identity mapping, then issues a session. Caller (controller) must gate this
   * to non-production. Uses withTenant() to create the tenant-scoped Staff object under RLS.
   */
  async devLoginStaff(input: {
    tenantId: string;
    openid?: string;
    handle: string;
    displayName?: string;
  }): Promise<{ token: string; identity: SessionIdentity }> {
    const openid = input.openid ?? `dev:staff:${input.tenantId}:${input.handle}`;
    const existing = await this.store.findStaffIdentity(openid);
    let staffId: string;
    if (existing && existing.tenant_id === input.tenantId) {
      staffId = existing.staff_id;
    } else {
      staffId = await this.provisionStaff(input.tenantId, input.handle, input.displayName, 'staff');
      await this.store.upsertStaffIdentity({ openid, tenantId: input.tenantId, staffId, displayName: input.displayName });
    }
    return this.issue('staff', { tenantId: input.tenantId, staffId });
  }

  /**
   * DEV-ONLY mock manager login: provisions a manager (Staff object, role=manager) + the
   * login→manager identity mapping, then issues a session. Prod manager login (email magic
   * link / SSO) is a founder-dependency TODO.
   */
  async devLoginManager(input: {
    tenantId: string;
    login: string;
    displayName?: string;
    role?: string;
  }): Promise<{ token: string; identity: SessionIdentity }> {
    const role = input.role ?? 'manager';
    const existing = await this.store.findManagerIdentity(input.login);
    let managerId: string;
    if (existing && existing.tenant_id === input.tenantId) {
      managerId = existing.manager_id;
    } else {
      managerId = await this.provisionStaff(input.tenantId, input.login, input.displayName, role);
      await this.store.upsertManagerIdentity({ login: input.login, tenantId: input.tenantId, managerId, role });
    }
    return this.issue('manager', { tenantId: input.tenantId, managerId, role });
  }

  /** Find-or-create a Staff object in the tenant (RLS-scoped via withTenant). */
  private async provisionStaff(
    tenantId: string,
    handle: string,
    displayName: string | undefined,
    role: string,
  ): Promise<string> {
    return withTenant(tenantId, async (c) => {
      const found = await c.query<{ id: string }>(
        `SELECT id FROM objects WHERE type = 'Staff' AND properties->>'staffHandle' = $1 LIMIT 1`,
        [handle],
      );
      if (found.rows[0]) return found.rows[0].id;
      const created = await c.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Staff', $2::jsonb) RETURNING id`,
        [tenantId, JSON.stringify({ staffHandle: handle, displayName: displayName ?? handle, role })],
      );
      const id = created.rows[0]!.id;
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'object.created', $3::jsonb, 'auth')`,
        [tenantId, id, JSON.stringify({ type: 'Staff', role })],
      );
      return id;
    });
  }

  private async issue(
    subject: 'staff' | 'manager',
    who: { tenantId: string; staffId?: string; managerId?: string; role?: string },
  ): Promise<{ token: string; identity: SessionIdentity }> {
    const token = this.newToken();
    await this.store.createSession({
      token,
      subject,
      tenantId: who.tenantId,
      staffId: who.staffId,
      managerId: who.managerId,
      role: who.role,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return { token, identity: { subject, tenantId: who.tenantId, staffId: who.staffId, managerId: who.managerId, role: who.role } };
  }
}
