import { describe, it, expect, afterEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { identityMeetsRoles } from './roles.policy';
import type { SessionIdentity } from '../auth/session.types';

const A = '11111111-1111-1111-1111-111111111111';

describe('identityMeetsRoles (pure policy)', () => {
  it('allows any caller when no roles are required', () => {
    expect(identityMeetsRoles(undefined, [], 'production')).toBe(true);
    expect(identityMeetsRoles({ subject: 'staff', tenantId: A }, [], 'production')).toBe(true);
  });

  it('requires an identity when roles are required', () => {
    expect(identityMeetsRoles(undefined, ['manager'], 'production')).toBe(false);
  });

  it('a manager satisfies a manager-only route; a staff does NOT (→ 403)', () => {
    expect(identityMeetsRoles({ subject: 'manager', tenantId: A, role: 'manager' }, ['manager'], 'production')).toBe(true);
    expect(identityMeetsRoles({ subject: 'staff', tenantId: A, staffId: 's1' }, ['manager'], 'production')).toBe(false);
  });

  it('a manager is a superset of staff for staff-accessible routes', () => {
    expect(identityMeetsRoles({ subject: 'staff', tenantId: A }, ['staff'], 'production')).toBe(true);
    expect(identityMeetsRoles({ subject: 'manager', tenantId: A, role: 'manager' }, ['staff'], 'production')).toBe(true);
  });

  it('the dev shim passes any role OUTSIDE production only', () => {
    const dev: SessionIdentity = { subject: 'dev', tenantId: A };
    expect(identityMeetsRoles(dev, ['manager'], 'development')).toBe(true);
    expect(identityMeetsRoles(dev, ['manager'], 'test')).toBe(true);
    expect(identityMeetsRoles(dev, ['manager'], undefined)).toBe(true);
    expect(identityMeetsRoles(dev, ['manager'], 'production')).toBe(false); // no dev shim in prod anyway
  });

  it('honors an explicit custom role match', () => {
    expect(identityMeetsRoles({ subject: 'manager', tenantId: A, role: 'admin' }, ['admin'], 'production')).toBe(true);
    expect(identityMeetsRoles({ subject: 'manager', tenantId: A, role: 'manager' }, ['admin'], 'production')).toBe(false);
  });
});

function ctx(required: string[] | undefined, auth: SessionIdentity | undefined): { context: ExecutionContext; reflector: Reflector } {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as unknown as ExecutionContext;
  return { context, reflector };
}

describe('RolesGuard', () => {
  const orig = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = orig;
  });

  it('allows an unrestricted route', () => {
    const { context, reflector } = ctx(undefined, undefined);
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  it('allows a manager on a manager-only route', () => {
    process.env.NODE_ENV = 'production';
    const { context, reflector } = ctx(['manager'], { subject: 'manager', tenantId: A, role: 'manager' });
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  it('403s a staff on a manager-only route (authenticated, not authorized)', () => {
    process.env.NODE_ENV = 'production';
    const { context, reflector } = ctx(['manager'], { subject: 'staff', tenantId: A, staffId: 's1' });
    expect(() => new RolesGuard(reflector).canActivate(context)).toThrowError(/privileges/i);
  });

  it('401s when no identity was resolved on a restricted route', () => {
    process.env.NODE_ENV = 'production';
    const { context, reflector } = ctx(['manager'], undefined);
    expect(() => new RolesGuard(reflector).canActivate(context)).toThrowError(/Authentication required/i);
  });
});
