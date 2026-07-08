import { describe, it, expect, afterEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { isUuid, headerTenantAllowed, extractSessionToken, TenantGuard, type TenantRequest } from './tenant.guard';
import type { SessionIdentity } from '../auth/session.types';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';

describe('isUuid', () => {
  it('accepts valid UUIDs', () => {
    expect(isUuid(A)).toBe(true);
    expect(isUuid('a56154b9-8149-4f35-8040-602cf4371ca5')).toBe(true);
  });
  it('rejects non-UUIDs', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(12345)).toBe(false);
  });
});

describe('headerTenantAllowed', () => {
  it('permits the header stand-in only outside production', () => {
    expect(headerTenantAllowed('development')).toBe(true);
    expect(headerTenantAllowed('test')).toBe(true);
    expect(headerTenantAllowed(undefined)).toBe(true);
    expect(headerTenantAllowed('production')).toBe(false);
  });
});

function req(opts: { headers?: Record<string, string>; query?: Record<string, unknown>; body?: Record<string, unknown> }): TenantRequest {
  const headers = opts.headers ?? {};
  return {
    header: (n: string) => headers[n.toLowerCase()],
    query: opts.query,
    body: opts.body,
  };
}
function ctx(r: TenantRequest): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => r }) } as unknown as ExecutionContext;
}
// Fake SessionService: resolves only the tokens in the map.
function sessions(map: Record<string, SessionIdentity>) {
  return { resolve: async (t: string) => map[t] ?? null } as unknown as ConstructorParameters<typeof TenantGuard>[0];
}

describe('extractSessionToken', () => {
  it('reads Bearer, ?session, and cv_session cookie', () => {
    expect(extractSessionToken(req({ headers: { authorization: 'Bearer abc123' } }))).toBe('abc123');
    expect(extractSessionToken(req({ query: { session: 'q-tok' } }))).toBe('q-tok');
    expect(extractSessionToken(req({ headers: { cookie: 'foo=1; cv_session=cook%2Dtok; bar=2' } }))).toBe('cook-tok');
    expect(extractSessionToken(req({}))).toBeUndefined();
  });
});

describe('TenantGuard — session-first, production-strict', () => {
  const orig = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = orig;
  });

  it('resolves tenant + staff from a valid session and IGNORES a self-reported X-Tenant-Id', async () => {
    process.env.NODE_ENV = 'production';
    const guard = new TenantGuard(sessions({ tok: { subject: 'staff', tenantId: A, staffId: 'staff-A' } }));
    const r = req({ headers: { authorization: 'Bearer tok', 'x-tenant-id': B } }); // forge attempt: header says B
    expect(await guard.canActivate(ctx(r))).toBe(true);
    expect(r.tenantId).toBe(A); // session wins; header B ignored
    expect(r.auth?.staffId).toBe('staff-A');
  });

  it('PRODUCTION: no session → 401 (Unauthorized), even with an X-Tenant-Id header', async () => {
    process.env.NODE_ENV = 'production';
    const guard = new TenantGuard(sessions({}));
    await expect(guard.canActivate(ctx(req({ headers: { 'x-tenant-id': A } })))).rejects.toMatchObject({ status: 401 });
    await expect(guard.canActivate(ctx(req({})))).rejects.toMatchObject({ status: 401 });
  });

  it('a present-but-invalid token is rejected in EVERY env (no silent dev fallback)', async () => {
    process.env.NODE_ENV = 'development';
    const guard = new TenantGuard(sessions({}));
    await expect(
      guard.canActivate(ctx(req({ headers: { authorization: 'Bearer bogus', 'x-tenant-id': A } }))),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('DEV shim: no session + X-Tenant-Id → resolves as subject=dev with the header handle', async () => {
    process.env.NODE_ENV = 'development';
    const guard = new TenantGuard(sessions({}));
    const r = req({ headers: { 'x-tenant-id': A, 'x-staff-handle': 'front' } });
    expect(await guard.canActivate(ctx(r))).toBe(true);
    expect(r.tenantId).toBe(A);
    expect(r.auth).toMatchObject({ subject: 'dev', tenantId: A, staffHandle: 'front' });
  });

  it('DEV shim: missing/invalid tenant → 400', async () => {
    process.env.NODE_ENV = 'development';
    const guard = new TenantGuard(sessions({}));
    await expect(guard.canActivate(ctx(req({ headers: { 'x-tenant-id': 'nope' } })))).rejects.toMatchObject({ status: 400 });
  });

  it('a valid session still wins over the dev shim (session tenant used, header ignored)', async () => {
    process.env.NODE_ENV = 'development';
    const guard = new TenantGuard(sessions({ tok: { subject: 'manager', tenantId: A, role: 'manager' } }));
    const r = req({ headers: { authorization: 'Bearer tok', 'x-tenant-id': B } });
    expect(await guard.canActivate(ctx(r))).toBe(true);
    expect(r.tenantId).toBe(A);
  });
});
