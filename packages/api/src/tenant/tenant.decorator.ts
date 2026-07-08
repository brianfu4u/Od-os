import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { TenantRequest } from './tenant.guard';
import type { SessionIdentity } from '../auth/session.types';

/** Injects the tenant id resolved by TenantGuard (from the session, or the dev shim). */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<TenantRequest>();
  return req.tenantId as string;
});

/** Injects the full resolved caller identity (subject/tenant/staff/manager/role). */
export const AuthIdentity = createParamDecorator((_data: unknown, ctx: ExecutionContext): SessionIdentity => {
  const req = ctx.switchToHttp().getRequest<TenantRequest>();
  return req.auth as SessionIdentity;
});

/** Injects the authenticated staff id (undefined for manager/dev callers). */
export const StaffId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  const req = ctx.switchToHttp().getRequest<TenantRequest>();
  return req.auth?.staffId;
});
