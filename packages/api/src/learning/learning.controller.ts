import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId } from '../tenant/tenant.decorator';
import { LearningService } from './learning.service';

/**
 * P4/S8 learning loop. Human-in-the-loop + auditable: `run` produces bounded parameter adjustments
 * (never silent model changes); `rollback` reverts the last run; the feedback/audit reads expose
 * the trail. The verdict-correction entry point lives on the verification controller
 * (POST /verifications/correct) since it also updates the object + ledger.
 *
 * Management-only: the entire learning surface is a command-center function, so it requires a
 * manager session (server-side enforced by RolesGuard).
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('manager')
@Controller('learning')
export class LearningController {
  constructor(private readonly learning: LearningService) {}

  /** Run the deterministic learner for this tenant (repeatable; converges, bounded). */
  @Post('run')
  run(@TenantId() tenantId: string) {
    return this.learning.run(tenantId);
  }

  /** Revert the most recent learn run to the previous parameter values. */
  @Post('rollback')
  rollback(@TenantId() tenantId: string) {
    return this.learning.rollback(tenantId);
  }

  @Get('feedback')
  feedback(@TenantId() tenantId: string, @Query('limit') limit?: string) {
    return this.learning.feedback(tenantId, limit !== undefined ? Number(limit) : undefined);
  }

  @Get('audit')
  audit(@TenantId() tenantId: string, @Query('limit') limit?: string) {
    return this.learning.audit(tenantId, limit !== undefined ? Number(limit) : undefined);
  }
}
