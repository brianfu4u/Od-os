import type { SessionIdentity } from '../auth/session.types';

/**
 * Pure authorization decision for role-restricted routes (unit-testable without Nest).
 *
 *  - No required roles ⇒ allowed (the route is not role-restricted).
 *  - No identity ⇒ NOT allowed (caller unauthenticated; the guard turns this into 401).
 *  - DEV SHIM (subject 'dev') ⇒ allowed for ANY role, but ONLY outside production. In production the
 *    dev shim does not exist (TenantGuard rejects any non-session caller), so this branch is a
 *    dev/CI convenience that can never widen access in prod.
 *  - Otherwise a caller satisfies the requirement when their explicit session role matches one of
 *    the required roles, OR they are a manager and 'manager' is required, OR the route requires
 *    'staff' and they are staff/manager (a manager is a superset of staff for staff-accessible
 *    routes).
 *
 * The frontend NEVER makes this decision — this runs server-side in RolesGuard.
 */
export function identityMeetsRoles(
  identity: SessionIdentity | undefined,
  required: readonly string[],
  nodeEnv: string | undefined,
): boolean {
  if (!required || required.length === 0) return true;
  if (!identity) return false;
  if (identity.subject === 'dev') return nodeEnv !== 'production';

  const role = identity.role;
  if (role && required.includes(role)) return true;
  if (required.includes('manager') && identity.subject === 'manager') return true;
  if (required.includes('staff') && (identity.subject === 'staff' || identity.subject === 'manager')) return true;
  return false;
}
