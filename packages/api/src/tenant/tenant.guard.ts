import {
  CanActivate,
  ExecutionContext,
  Injectable,
  BadRequestException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { SessionService } from '../auth/session.service';
import type { SessionIdentity } from '../auth/session.types';

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
  body?: Record<string, unknown>;
  tenantId?: string;
  auth?: SessionIdentity;
}

/**
 * Extracts an opaque session token from (in order): `Authorization: Bearer <t>`, a `?session=<t>`
 * query param (for EventSource/SSE, which cannot set headers — a bearer credential in the query is
 * fine, unlike a self-reported identity), or the `cv_session` cookie.
 */
export function extractSessionToken(req: TenantRequest): string | undefined {
  const authz = req.header('authorization');
  if (authz && /^Bearer\s+/i.test(authz)) return authz.replace(/^Bearer\s+/i, '').trim();
  const q = req.query?.session;
  if (typeof q === 'string' && q) return q;
  const cookie = req.header('cookie');
  if (cookie) {
    const m = /(?:^|;\s*)cv_session=([^;]+)/.exec(cookie);
    if (m) return decodeURIComponent(m[1]!);
  }
  return undefined;
}

/**
 * Resolves the caller's tenant (and staff/manager) identity.
 *
 * PRODUCTION: a valid session is REQUIRED. Identity comes only from the session; any
 * `X-Tenant-Id` / `staffHandle` a client sends is ignored. No session → 401.
 *
 * NON-PRODUCTION (dev/test) ONLY: if there is no session token, a DEV SHIM accepts an
 * `X-Tenant-Id` header / `?tenantId=` query (+ optional `X-Staff-Handle` / body `staffHandle`)
 * so the local harness and command-center dev flow keep working with synthetic data. A token
 * that is present but invalid/expired is always rejected — no silent downgrade to the shim.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(@Optional() private readonly sessions?: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<TenantRequest>();

    // 1) Session-first (all environments).
    const token = extractSessionToken(req);
    if (token) {
      const identity = this.sessions ? await this.sessions.resolve(token) : null;
      if (!identity) throw new UnauthorizedException('Invalid or expired session.');
      req.auth = identity;
      req.tenantId = identity.tenantId;
      return true;
    }

    // 2) No session. Production never trusts client-supplied identity.
    if (!headerTenantAllowed(process.env.NODE_ENV)) {
      throw new UnauthorizedException('Authentication required: a valid session is mandatory (S0-3).');
    }

    // 3) DEV SHIM (non-production only).
    const fromHeader = req.header('x-tenant-id');
    const fromQuery = typeof req.query?.tenantId === 'string' ? req.query.tenantId : undefined;
    const tenant = fromHeader ?? fromQuery;
    if (!isUuid(tenant)) {
      throw new BadRequestException(
        'Missing or invalid tenant (dev: X-Tenant-Id header or tenantId query; production requires a session).',
      );
    }
    const handle =
      req.header('x-staff-handle') ??
      (typeof req.body?.staffHandle === 'string' ? (req.body.staffHandle as string) : undefined);
    const displayName = typeof req.body?.staffDisplayName === 'string' ? (req.body.staffDisplayName as string) : undefined;
    req.tenantId = tenant;
    req.auth = { subject: 'dev', tenantId: tenant, staffHandle: handle, staffDisplayName: displayName };
    return true;
  }
}
