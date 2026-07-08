import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';
import { SessionStore } from './session.store';
import { TenantGuard } from '../tenant/tenant.guard';

/**
 * @Global so `TenantGuard` (which now depends on SessionService) resolves wherever a controller
 * does `@UseGuards(TenantGuard)` — reports, uploads, objects, overview, recommendations — without
 * each module re-registering it.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [SessionStore, SessionService, TenantGuard],
  exports: [SessionStore, SessionService, TenantGuard],
})
export class AuthModule {}
