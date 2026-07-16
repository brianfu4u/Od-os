import { describe, it, expect, afterEach } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ObjectsController } from './objects.controller';
import { RolesGuard } from '../tenant/roles.guard';
import type { SessionIdentity } from '../auth/session.types';

/**
 * P0-1 (DB-free): prove the generic /objects write surface is manager-gated at the authorization
 * boundary and that reads stay open. We read the REAL @Roles metadata off the controller methods
 * (so this fails if a decorator is dropped) and drive the REAL RolesGuard with it.
 */

const A = '11111111-1111-1111-1111-111111111111';
const reflector = new Reflector();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown;

function rolesFor(handler: Handler): string[] | undefined {
  return reflector.getAllAndOverride<string[] | undefined>('cv_roles', [handler, ObjectsController]);
}

function ctx(handler: Handler, auth: SessionIdentity | undefined): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => ObjectsController,
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as unknown as ExecutionContext;
}

const p = ObjectsController.prototype;
const staff: SessionIdentity = { subject: 'staff', tenantId: A, staffId: 's1' };
const manager: SessionIdentity = { subject: 'manager', tenantId: A, role: 'manager' };

describe('ObjectsController P0-1 authorization', () => {
  const orig = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = orig;
  });

  it('write routes (create / update / remove) require the manager role', () => {
    expect(rolesFor(p.create)).toEqual(['manager']);
    expect(rolesFor(p.update)).toEqual(['manager']);
    expect(rolesFor(p.remove)).toEqual(['manager']);
  });

  it('read routes (list / get / timeline) are NOT role-restricted', () => {
    expect(rolesFor(p.list)).toBeUndefined();
    expect(rolesFor(p.get)).toBeUndefined();
    expect(rolesFor(p.timeline)).toBeUndefined();
  });

  it('a staff token is rejected (403) on every write route', () => {
    process.env.NODE_ENV = 'production';
    const guard = new RolesGuard(reflector);
    for (const h of [p.create, p.update, p.remove]) {
      expect(() => guard.canActivate(ctx(h, staff))).toThrowError(/privileges/i);
    }
  });

  it('a manager token is allowed on every write route', () => {
    process.env.NODE_ENV = 'production';
    const guard = new RolesGuard(reflector);
    for (const h of [p.create, p.update, p.remove]) {
      expect(guard.canActivate(ctx(h, manager))).toBe(true);
    }
  });

  it('a staff token can still READ objects (list / get stay open)', () => {
    process.env.NODE_ENV = 'production';
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx(p.list, staff))).toBe(true);
    expect(guard.canActivate(ctx(p.get, staff))).toBe(true);
  });
});
