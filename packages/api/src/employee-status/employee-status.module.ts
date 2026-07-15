import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { EmployeeStatusController } from './employee-status.controller';
import { EmployeeStatusService } from './employee-status.service';
import { EmployeeStatusRepository } from './employee-status.repository';

/**
 * T-04 · employee work-status (feat/business-flow-p0, Stage 2). Additive NEW module: writes only the
 * Staff object's claimed_state + the append-only employee_status_claims ledger + an
 * `employee.status.claimed` event. It never touches flow_id/flow_state or S2 verify().
 *
 * Imports ObjectsModule for RealtimeService (a thin broadcast-only SSE nudge to the manager board).
 * TenantGuard is provided globally by AuthModule; RolesGuard depends only on Reflector, so the
 * controller's @UseGuards(TenantGuard, RolesGuard) resolves without extra wiring.
 */
@Module({
  imports: [ObjectsModule],
  controllers: [EmployeeStatusController],
  providers: [EmployeeStatusService, EmployeeStatusRepository],
})
export class EmployeeStatusModule {}
