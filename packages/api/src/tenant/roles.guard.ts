import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator';
import { identityMeetsRoles } from './roles.policy';
import type { TenantRequest } from './tenant.guard';

/**
 * Role enforcement. MUST run AFTER TenantGuard (which resolves + attaches req.auth); controllers
 * list it as `@UseGuards(TenantGuard, RolesGuard)`. Reads the required roles from @Roles() metadata
 * on the handler (falling back to the controller class).
 *
 *  - Route not role-restricted ⇒ allowed.
 *  - No authenticated identity ⇒ 401 (should not happen when TenantGuard ran, but fail-closed).
 *  - Authenticated but wrong role ⇒ 403 (authenticated, not authorized).
 *
 * This is the server-side authorization boundary. Any UI hiding is cosmetic only.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<TenantRequest>();
    const identity = req.auth;
    if (!identity) throw new UnauthorizedException('Authentication required.');
    if (!identityMeetsRoles(identity, required, process.env.NODE_ENV)) {
      throw new ForbiddenException('This action requires elevated privileges.');
    }
    return true;
  }
}
