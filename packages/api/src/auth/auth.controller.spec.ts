import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { SessionService } from './session.service';

/**
 * T1: the staff/manager STAGING logins share one env-gated, password-protected helper. These tests
 * pin its three outcomes — gated-off (404), wrong password (401), and a correctly-authenticated
 * session bound to the SERVER-SIDE tenant (never a client-supplied one). This is the mechanism that
 * lets a phone terminal authenticate on staging (NODE_ENV=production) without re-opening the
 * wide-open dev-login in prod.
 */
const STAGING_TENANT = '22222222-2222-2222-2222-222222222222';

function makeController() {
  const devLoginStaff = vi.fn(async ({ tenantId }: { tenantId: string }) => ({
    token: 'staff-tok',
    identity: { subject: 'staff' as const, tenantId, staffId: 'staff-1' },
  }));
  const devLoginManager = vi.fn(async ({ tenantId }: { tenantId: string }) => ({
    token: 'mgr-tok',
    identity: { subject: 'manager' as const, tenantId, managerId: 'mgr-1' },
  }));
  const sessions = { devLoginStaff, devLoginManager } as unknown as SessionService;
  return { controller: new AuthController(sessions), devLoginStaff, devLoginManager };
}

const res = { setHeader: vi.fn() };

describe('AuthController staging logins (env-gated shared password gate)', () => {
  const saved = {
    enabled: process.env.STAGING_LOGIN_ENABLED,
    password: process.env.STAGING_LOGIN_PASSWORD,
    tenant: process.env.STAGING_TENANT_ID,
  };

  beforeEach(() => {
    res.setHeader.mockClear();
    process.env.STAGING_LOGIN_ENABLED = 'true';
    process.env.STAGING_LOGIN_PASSWORD = 'let-me-in';
    process.env.STAGING_TENANT_ID = STAGING_TENANT;
  });
  afterEach(() => {
    process.env.STAGING_LOGIN_ENABLED = saved.enabled;
    process.env.STAGING_LOGIN_PASSWORD = saved.password;
    process.env.STAGING_TENANT_ID = saved.tenant;
  });

  it('staff staging-login mints a staff session bound to the server-side tenant', async () => {
    const { controller, devLoginStaff } = makeController();
    const out = await controller.stagingStaffLogin({ password: 'let-me-in', handle: 'nurse-a' }, res);
    expect(out.token).toBe('staff-tok');
    expect(out.identity.tenantId).toBe(STAGING_TENANT);
    expect(devLoginStaff).toHaveBeenCalledWith({ tenantId: STAGING_TENANT, handle: 'nurse-a', displayName: undefined });
    expect(res.setHeader).toHaveBeenCalled(); // session cookie set
  });

  it('staff staging-login falls back to a default handle when none is given', async () => {
    const { controller, devLoginStaff } = makeController();
    await controller.stagingStaffLogin({ password: 'let-me-in' }, res);
    expect(devLoginStaff).toHaveBeenCalledWith({ tenantId: STAGING_TENANT, handle: 'staff', displayName: undefined });
  });

  it('manager staging-login mints a manager session bound to the server-side tenant', async () => {
    const { controller, devLoginManager } = makeController();
    const out = await controller.stagingManagerLogin({ password: 'let-me-in' }, res);
    expect(out.identity.tenantId).toBe(STAGING_TENANT);
    expect(devLoginManager).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: STAGING_TENANT, login: 'staging-manager', role: 'manager' }),
    );
  });

  it('rejects a wrong password with 401 (constant-time compare)', async () => {
    const { controller, devLoginStaff } = makeController();
    await expect(controller.stagingStaffLogin({ password: 'nope', handle: 'x' }, res)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(devLoginStaff).not.toHaveBeenCalled();
  });

  it('404s (never exposed) when STAGING_LOGIN_ENABLED is not set — the prod default', async () => {
    process.env.STAGING_LOGIN_ENABLED = 'false';
    const { controller } = makeController();
    await expect(controller.stagingStaffLogin({ password: 'let-me-in', handle: 'x' }, res)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(controller.stagingManagerLogin({ password: 'let-me-in' }, res)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
