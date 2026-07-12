import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';
import { OpsRepository } from './ops.repository';

/**
 * Ops observability module. TenantGuard is provided globally by AuthModule; RolesGuard depends only
 * on Reflector (Nest core), so both resolve for @UseGuards on the controller without extra wiring.
 * The metrics registry, interceptor, and exception filter are plain singletons registered globally
 * in main.ts (no DI), so they are not providers here.
 */
@Module({
  controllers: [OpsController],
  providers: [OpsService, OpsRepository],
})
export class OpsModule {}
