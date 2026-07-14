import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { AssignmentController } from './assignment.controller';
import { AssignmentService } from './assignment.service';
import { AssignmentRepository } from './assignment.repository';

/**
 * Manager task assignment (feat/manager-task-assign). Additive: a NEW module that does not touch T5
 * (/tasks/mine) — it only writes the assignedTo link T5 already reads. TenantGuard is provided
 * globally by AuthModule; RolesGuard depends only on Reflector (Nest core), so the controller's
 * @UseGuards(TenantGuard, RolesGuard) resolves without extra wiring.
 */
@Module({
  imports: [ObjectsModule], // for RealtimeService (employee-facing SSE on approve/reject)
  controllers: [AssignmentController],
  providers: [AssignmentService, AssignmentRepository],
})
export class AssignmentsModule {}
