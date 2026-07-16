/** Resolved caller identity attached to the request by the guard. */
export interface SessionIdentity {
  /** 'staff' / 'manager' come from a real session; 'dev' is the non-production header shim. */
  subject: 'staff' | 'manager' | 'dev';
  tenantId: string;
  staffId?: string;
  managerId?: string;
  role?: string;
  /** DEV-SHIM ONLY: a self-reported staff handle (never set for real sessions). */
  staffHandle?: string;
  /** DEV-SHIM ONLY: a self-reported display name. */
  staffDisplayName?: string;
}

export interface SessionRow {
  /** SHA-256 hash of the opaque token (the raw token is never persisted — P0-2). */
  token_hash: string;
  subject: 'staff' | 'manager';
  tenant_id: string;
  staff_id: string | null;
  manager_id: string | null;
  role: string | null;
  expires_at: string;
}

export interface StaffIdentityRow {
  openid: string;
  tenant_id: string;
  staff_id: string;
  display_name: string | null;
}

export interface ManagerIdentityRow {
  login: string;
  tenant_id: string;
  manager_id: string;
  role: string;
  /** scrypt-encoded credential (0012). NULL ⇒ this manager has no password login yet. */
  password_hash: string | null;
}
