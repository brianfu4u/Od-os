import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { SessionService } from './session.service';

/**
 * T1: the staff/manager STAGING logins share one env-gated, password-protected helper. These tests
 * pin its three outcomes — gated-off (404), wrong password (401), and a correctly-authenticated
 * session bound to the SERVER-SIDE tenant (never a client-supplied one). This is the mechanism that
 * lets a phone terminal authenticate on staging (NODE_ENV=production) without re-opening the
 * wide-open dev-login in prod.
 *
 * feat/manager-auth: adds coverage for the real credential login (POST /auth/manager/login), which
 * works in EVERY environment (incl. production) and mints a manager session via loginManager.
 */
const STAGING_TENANT = '22222222-2222-2222-2222-222222222222';
const REAL_TENANT = '11111111-1111-1111-1111-111111111111';

function makeController() {
  const devLoginStaff = vi.fn(async ({ tenantId }: { tenantId: string }) => ({
    token: 'staff-tok',
    identity: { subject: 'staff' as const, tenantId, staffId: 'staff-1' },
  }));
  const devLoginManager = vi.fn(async ({ tenantId }: { tenantId: string }) => ({
    token: 'mgr-tok',
    identity: { subject: 'manager' as const, tenantId, managerId: 'mgr-1' },
  }));
  const loginManager = vi.fn(async ({ login }: { login: string; password: string }) => ({
    token: 'real-mgr-tok',
    identity: { subject: 'manager' as const, tenantId: REAL_TENANT, managerId: `mgr-${login}`, role: 'manager' },
  }));
  const sessions = { devLoginStaff, devLoginManager, loginManager } as unknown as SessionService;
  return { controller: new AuthController(sessions), devLoginStaff, devLoginManager, loginManager };
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

describe('AuthController manager credential login (feat/manager-auth)', () => {
  const savedEnv = process.env.NODE_ENV;
  beforeEach(() => res.setHeader.mockClear());
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
  });

  it('mints a manager session via loginManager and sets the session cookie', async () => {
    const { controller, loginManager } = makeController();
    const out = await controller.managerLogin({ login: 'dana', password: 'a-strong-password' }, res);
    expect(out.token).toBe('real-mgr-tok');
    expect(out.identity).toMatchObject({ subject: 'manager', tenantId: REAL_TENANT, role: 'manager' });
    expect(loginManager).toHaveBeenCalledWith({ login: 'dana', password: 'a-strong-password' });
    expect(res.setHeader).toHaveBeenCalled();
  });

  it('trims the login and requires both fields (400 otherwise, without calling loginManager)', async () => {
    const { controller, loginManager } = makeController();
    await controller.managerLogin({ login: '  dana  ', password: 'pw123456789012' }, res);
    expect(loginManager).toHaveBeenCalledWith({ login: 'dana', password: 'pw123456789012' });

    loginManager.mockClear();
    await expect(controller.managerLogin({ login: '', password: 'x' }, res)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.managerLogin({ login: 'dana' }, res)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.managerLogin({}, res)).rejects.toBeInstanceOf(BadRequestException);
    expect(loginManager).not.toHaveBeenCalled();
  });

  it('is NOT NODE_ENV-gated — it authenticates in production (unlike dev-login)', async () => {
    process.env.NODE_ENV = 'production';
    const { controller, loginManager } = makeController();
    const out = await controller.managerLogin({ login: 'dana', password: 'a-strong-password' }, res);
    expect(out.token).toBe('real-mgr-tok');
    expect(loginManager).toHaveBeenCalled();
  });

  it('manager/dev-login still 404s in production (the wide-open mock stays closed)', async () => {
    process.env.NODE_ENV = 'production';
    const { controller } = makeController();
    await expect(
      controller.devManagerLogin({ tenantId: REAL_TENANT, login: 'dana' }, res),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
