import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { withTenant } from '../database/tenant-context';
import { SessionStore } from './session.store';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password';
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
   * PROD manager path: authenticate a manager by login + password against the stored scrypt hash.
   * Works in EVERY environment (including production) — this is the real credential login, NOT the
   * dev/staging shim. The tenant + role come from the server-side manager_identities row; the client
   * NEVER supplies a tenant. On any failure it throws a GENERIC 401 (no user-enumeration): an unknown
   * login (or one with no credential yet) still runs a constant-time dummy verify so the timing does
   * not reveal whether the login exists.
   */
  async loginManager(input: { login: string; password: string }): Promise<{ token: string; identity: SessionIdentity }> {
    const idn = await this.store.findManagerIdentity(input.login);
    if (!idn || !idn.password_hash) {
      verifyPassword(input.password, DUMMY_PASSWORD_HASH); // burn ~equal time, then deny
      throw new UnauthorizedException('invalid credentials');
    }
    if (!verifyPassword(input.password, idn.password_hash)) {
      throw new UnauthorizedException('invalid credentials');
    }
    return this.issue('manager', { tenantId: idn.tenant_id, managerId: idn.manager_id, role: idn.role });
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
   * login→manager identity mapping, then issues a session. Prod manager login is the real
   * credential path (loginManager); this mock stays NODE_ENV-gated (404 in production).
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

  /**
   * Idempotent manager seed (synthetic bootstrap). Provisions the manager identity if missing and
   * sets the credential hash. Called from ManagerSeedService when MANAGER_SEED_* env is present.
   *  - New manager → provision Staff(role) + identity mapping + set password ⇒ 'created'.
   *  - Existing WITHOUT a credential → set password ⇒ 'updated'.
   *  - Existing WITH a credential → left untouched (⇒ 'skipped') unless force=true (rotation).
   * Stores ONLY the scrypt hash — never the plaintext.
   */
  async seedManager(input: {
    tenantId: string;
    login: string;
    password: string;
    displayName?: string;
    role?: string;
    force?: boolean;
  }): Promise<{ action: 'created' | 'updated' | 'skipped'; managerId: string }> {
    const role = input.role ?? 'manager';
    const existing = await this.store.findManagerIdentity(input.login);
    let managerId: string;
    if (existing && existing.tenant_id === input.tenantId) {
      managerId = existing.manager_id;
    } else {
      managerId = await this.provisionStaff(input.tenantId, input.login, input.displayName, role);
      await this.store.upsertManagerIdentity({ login: input.login, tenantId: input.tenantId, managerId, role });
    }
    const hasCredential = Boolean(existing?.password_hash);
    if (hasCredential && !input.force) return { action: 'skipped', managerId };
    await this.store.setManagerPassword(input.login, hashPassword(input.password));
    return { action: existing ? 'updated' : 'created', managerId };
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
