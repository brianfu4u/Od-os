import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { TenantRequest } from './tenant.guard';

/** Injects the tenant id resolved by TenantGuard. */
export const TenantId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<TenantRequest>();
  return req.tenantId as string;
});
