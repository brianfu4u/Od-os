import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import type { SessionService } from './session.service';
import { SseTicketService } from './sse-ticket.service';
import { LoginThrottleService } from './login-throttle.service';

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
  const tickets = new SseTicketService();
  const throttle = new LoginThrottleService();
  const controller = new AuthController(sessions, tickets, throttle);
  return { controller, devLoginStaff, devLoginManager, loginManager, tickets, throttle };
}

const res = { setHeader: vi.fn() };
const req = { header: () => undefined } as unknown as Parameters<AuthController['managerLogin']>[1];

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
    const out = await controller.managerLogin({ login: 'dana', password: 'a-strong-password' }, req, res);
    expect(out.token).toBe('real-mgr-tok');
    expect(out.identity).toMatchObject({ subject: 'manager', tenantId: REAL_TENANT, role: 'manager' });
    expect(loginManager).toHaveBeenCalledWith({ login: 'dana', password: 'a-strong-password' });
    expect(res.setHeader).toHaveBeenCalled();
  });

  it('trims the login and requires both fields (400 otherwise, without calling loginManager)', async () => {
    const { controller, loginManager } = makeController();
    await controller.managerLogin({ login: '  dana  ', password: 'pw123456789012' }, req, res);
    expect(loginManager).toHaveBeenCalledWith({ login: 'dana', password: 'pw123456789012' });

    loginManager.mockClear();
    await expect(controller.managerLogin({ login: '', password: 'x' }, req, res)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.managerLogin({ login: 'dana' }, req, res)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.managerLogin({}, req, res)).rejects.toBeInstanceOf(BadRequestException);
    expect(loginManager).not.toHaveBeenCalled();
  });

  it('is NOT NODE_ENV-gated — it authenticates in production (unlike dev-login)', async () => {
    process.env.NODE_ENV = 'production';
    const { controller, loginManager } = makeController();
    const out = await controller.managerLogin({ login: 'dana', password: 'a-strong-password' }, req, res);
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

/**
 * P0-2 sub-issue 2 (test (c)): the token is delivered as an HttpOnly cookie, never a body field the
 * browser can persist to localStorage. In production the cross-site (Vercel↔Render) cookie must be
 * `SameSite=None; Secure`; in dev it is `SameSite=Lax` and non-Secure so it works over plain http.
 */
describe('AuthController session cookie (P0-2 sub-issue 2)', () => {
  const savedEnv = process.env.NODE_ENV;
  beforeEach(() => res.setHeader.mockClear());
  afterEach(() => {
    process.env.NODE_ENV = savedEnv;
  });

  function cookieHeader(): string {
    const call = res.setHeader.mock.calls.find((c) => c[0] === 'Set-Cookie');
    expect(call, 'expected a Set-Cookie header').toBeTruthy();
    return call![1] as string;
  }

  it('sets an HttpOnly, SameSite=None, Secure cookie in production', async () => {
    process.env.NODE_ENV = 'production';
    const { controller } = makeController();
    await controller.managerLogin({ login: 'dana', password: 'a-strong-password' }, req, res);
    const cookie = cookieHeader();
    expect(cookie).toMatch(/^cv_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
  });

  it('uses SameSite=Lax and omits Secure outside production (plain-http dev)', async () => {
    process.env.NODE_ENV = 'development';
    const { controller } = makeController();
    await controller.managerLogin({ login: 'dana', password: 'a-strong-password' }, req, res);
    const cookie = cookieHeader();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });
});

/**
 * P0-2 sub-issue 4b (test (g)): after N failed manager logins the key is locked and further attempts
 * are refused with 429 BEFORE loginManager is even called — so even a would-be-correct password is
 * rejected until the window clears.
 */
describe('AuthController manager-login lockout (P0-2 sub-issue 4b)', () => {
  it('locks the account+IP after 5 failures and 429s the next attempt without verifying', async () => {
    const { controller, loginManager } = makeController();
    loginManager.mockRejectedValue(new UnauthorizedException('invalid login'));
    for (let i = 0; i < 5; i += 1) {
      await expect(controller.managerLogin({ login: 'dana', password: 'wrong' }, req, res)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
    loginManager.mockClear();
    // 6th attempt: locked → 429, and loginManager is never called (the correct password can't get in).
    let thrown: unknown;
    try {
      await controller.managerLogin({ login: 'dana', password: 'the-correct-password' }, req, res);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    expect(loginManager).not.toHaveBeenCalled();
  });
});
