import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure helper (unit-testable without Nest). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The X-Tenant-Id header stand-in is DEV-ONLY; never trusted in production. */
export function headerTenantAllowed(nodeEnv: string | undefined): boolean {
  return nodeEnv !== 'production';
}

/** Minimal structural shape of the request we rely on (avoids an express type dep). */
export interface TenantRequest {
  header(name: string): string | undefined;
  query?: Record<string, unknown>;
  tenantId?: string;
}

/**
 * Resolves the tenant from the `X-Tenant-Id` header (DEV ONLY).
 *
 * !!! TODO(S0-3) SECURITY — DO NOT SHIP TO PRODUCTION AS-IS !!!
 * This trusts a client-supplied tenant id after only a UUID format check. A caller
 * could pass ANOTHER tenant's id and RLS would then faithfully serve that tenant's
 * rows — fine for synthetic dev data, a cross-tenant data leak with real data. S0-3
 * MUST derive the tenant from the authenticated session and REJECT any client-supplied
 * tenant. Until then this guard is hard-disabled outside development.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!headerTenantAllowed(process.env.NODE_ENV)) {
      throw new UnauthorizedException(
        'X-Tenant-Id header auth is disabled outside development; an authenticated session is required (S0-3).',
      );
    }
    const req = context.switchToHttp().getRequest<TenantRequest>();
    // Header is primary; a `tenantId` query param is accepted too (dev-only) so browser
    // EventSource (SSE) — which cannot set headers — can pass the tenant. Both are gated
    // by headerTenantAllowed above; S0-3 replaces all of this with the session.
    const fromHeader = req.header('x-tenant-id');
    const fromQuery = typeof req.query?.tenantId === 'string' ? req.query.tenantId : undefined;
    const tenant = fromHeader ?? fromQuery;
    if (!isUuid(tenant)) {
      throw new BadRequestException('Missing or invalid tenant (X-Tenant-Id header or tenantId query, UUID).');
    }
    req.tenantId = tenant;
    return true;
  }
}
