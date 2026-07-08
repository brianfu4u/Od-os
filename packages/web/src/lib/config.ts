/**
 * Runtime config for the command center. In production the tenant comes from the
 * authenticated session (S0-3) — this dev tenant + client-supplied X-Tenant-Id is a
 * DEV-ONLY convenience matching the API's dev-only TenantGuard.
 */

/** API origin. Browser reads NEXT_PUBLIC_API_BASE; defaults to the local dev API. */
export const API_BASE =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_BASE) || 'http://localhost:3001';

/** Dev tenant — Tenant A from the seed (the Room-3 cross-verification story). */
export const DEV_TENANT_ID =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_TENANT_ID) ||
  '11111111-1111-1111-1111-111111111111';

/** Cosmetic clinic identity for the podium (synthetic). */
export const CLINIC = {
  branch: 'Riverside',
  commander: 'Dana Whitfield',
};
