/**
 * Runtime config for the command center. In production the tenant comes from the
 * authenticated session (S0-3) — this dev tenant + client-supplied X-Tenant-Id is a
 * DEV-ONLY convenience matching the API's dev-only TenantGuard.
 */

/**
 * API origin. Reads `NEXT_PUBLIC_API_BASE_URL` (the documented name in .env.example / deploy) and
 * falls back to the legacy `NEXT_PUBLIC_API_BASE`, then to the local dev API. (Both are accepted so
 * a staging deploy that sets `NEXT_PUBLIC_API_BASE_URL` actually points the browser at the API.)
 */
export const API_BASE =
  (typeof process !== 'undefined' &&
    (process.env.NEXT_PUBLIC_API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE)) ||
  'http://localhost:3001';

/** Staging mode: the login form uses the password-gated staging login instead of the dev tenant picker. */
export const IS_STAGING = typeof process !== 'undefined' && process.env.NEXT_PUBLIC_STAGING === 'true';

/** Dev tenant — Tenant A from the seed (the Room-3 cross-verification story). */
export const DEV_TENANT_ID =
  (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_TENANT_ID) ||
  '11111111-1111-1111-1111-111111111111';

/**
 * Dev-only tenant choices for the mock manager login. In production the tenant comes from the
 * authenticated session (S0-3) and is never picked client-side; this list only exists so the
 * dev-gated `/auth/manager/dev-login` has something to sign into against the two seeded tenants.
 */
export interface TenantOption {
  id: string;
  label: string;
}
export const DEV_TENANTS: TenantOption[] = [
  { id: '11111111-1111-1111-1111-111111111111', label: 'Riverside (Tenant A)' },
  { id: '22222222-2222-2222-2222-222222222222', label: 'Second Clinic (Tenant B)' },
];

/** Cosmetic clinic identity for the podium (synthetic). */
export const CLINIC = {
  branch: 'Riverside',
  commander: 'Dana Whitfield',
};
