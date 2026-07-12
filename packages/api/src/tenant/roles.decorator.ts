import { SetMetadata } from '@nestjs/common';

/** Metadata key holding the required roles for a route/controller. */
export const ROLES_KEY = 'cv_roles';

/**
 * Restrict a route (or a whole controller) to callers whose authenticated session carries one of
 * the given roles. Enforced server-side by RolesGuard; the frontend is never the boundary.
 * Example: `@Roles('manager')` on the command-center management endpoints.
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
