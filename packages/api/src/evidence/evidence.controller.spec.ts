import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionIdentity } from '../auth/session.types';
import { RolesGuard } from '../tenant/roles.guard';
import { EvidenceController } from './evidence.controller';
import { PhotoEvidenceService } from './photo-evidence.service';

const tenant = '11111111-1111-1111-1111-111111111111';
const reflector = new Reflector();
const handler = EvidenceController.prototype.receivePhoto;

function context(auth: SessionIdentity | undefined): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => EvidenceController,
    switchToHttp: () => ({ getRequest: () => ({ auth }) }),
  } as unknown as ExecutionContext;
}

describe('EvidenceController authorization', () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('requires staff, allowing staff and manager sessions', () => {
    expect(reflector.getAllAndOverride('cv_roles', [handler, EvidenceController])).toEqual([
      'staff',
    ]);
    process.env.NODE_ENV = 'production';
    const guard = new RolesGuard(reflector);
    expect(
      guard.canActivate(context({ subject: 'staff', tenantId: tenant, staffId: 'staff-1' })),
    ).toBe(true);
    expect(
      guard.canActivate(
        context({ subject: 'manager', tenantId: tenant, managerId: 'manager-1', role: 'manager' }),
      ),
    ).toBe(true);
  });

  it('fails closed for no identity (401) and the dev shim in production (403)', () => {
    process.env.NODE_ENV = 'production';
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(context(undefined))).toThrowError(/Authentication required/i);
    expect(() => guard.canActivate(context({ subject: 'dev', tenantId: tenant }))).toThrowError(
      /privileges/i,
    );
  });

  it('rejects a request with no multipart file', () => {
    const service = { receive: vi.fn() } as unknown as PhotoEvidenceService;
    const controller = new EvidenceController(service);
    expect(() =>
      controller.receivePhoto(
        tenant,
        { subject: 'staff', tenantId: tenant, staffId: 'staff-1' },
        undefined,
        {},
      ),
    ).toThrow(BadRequestException);
    expect(service.receive).not.toHaveBeenCalled();
  });
});
