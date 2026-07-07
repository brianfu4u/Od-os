import { CanActivate, ExecutionContext, Injectable, BadRequestException } from '@nestjs/common';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure helper (unit-testable without Nest). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Minimal structural shape of the request we rely on (avoids an express type dep). */
export interface TenantRequest {
  header(name: string): string | undefined;
  tenantId?: string;
}

/**
 * Resolves the tenant from the `X-Tenant-Id` header and attaches it to the request.
 * TEMPORARY: real auth/session lands in S0-3; until then the tenant is supplied
 * explicitly per request. Every downstream query runs via withTenant() so RLS is
 * the actual isolation boundary — this guard just names the tenant.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<TenantRequest>();
    const header = req.header('x-tenant-id');
    if (!isUuid(header)) {
      throw new BadRequestException('Missing or invalid X-Tenant-Id header (expected a UUID).');
    }
    req.tenantId = header;
    return true;
  }
}
