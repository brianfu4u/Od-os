import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';
import { SessionStore } from './session.store';
import { ManagerSeedService } from './manager-seed.service';
import { SseTicketService } from './sse-ticket.service';
import { LoginThrottleService } from './login-throttle.service';
import { TenantGuard } from '../tenant/tenant.guard';

/**
 * @Global so `TenantGuard` (which now depends on SessionService) resolves wherever a controller
 * does `@UseGuards(TenantGuard)` — reports, uploads, objects, overview, recommendations — without
 * each module re-registering it. RolesGuard depends only on Reflector (Nest core), so it needs no
 * provider registration; controllers list it directly in @UseGuards after TenantGuard.
 *
 * ManagerSeedService runs the idempotent, env-gated synthetic manager seed at bootstrap.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [SessionStore, SessionService, ManagerSeedService, SseTicketService, LoginThrottleService, TenantGuard],
  exports: [SessionStore, SessionService, SseTicketService, TenantGuard],
})
export class AuthModule {}
