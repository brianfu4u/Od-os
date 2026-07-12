import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { AssignmentOverview, AssignmentResult, AssignTaskInput, CreateTaskInput } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { AssignmentService } from './assignment.service';
import { validateAssignInput, validateCreateTaskInput, normalizeCreateTaskInput } from './assignment.validation';

/** Who performed the assignment — session-derived (never client-supplied). Recorded on the event. */
function actorOf(identity: SessionIdentity | undefined): string {
  return identity?.managerId ? `manager:${identity.managerId}` : 'manager';
}

/**
 * Manager task assignment — command-center, MANAGER-ONLY write path. TenantGuard resolves the
 * session tenant + role; RolesGuard enforces manager (a staff/unknown caller → 403). Every write is
 * tenant-scoped (withTenant/RLS) and the task + assignee are re-validated in the caller's tenant
 * server-side. Only the assignedTo link + Task properties are written — never verified_state.
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('manager')
@Controller('assignments')
export class AssignmentController {
  constructor(private readonly assignments: AssignmentService) {}

  /** This tenant's tasks (+ current assignee) and assignable staff. */
  @Get('overview')
  overview(@TenantId() tenantId: string): Promise<AssignmentOverview> {
    return this.assignments.overview(tenantId);
  }

  /** Assign/reassign a task to a staff member in this tenant. */
  @Post('assign')
  assign(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity | undefined,
    @Body() body: AssignTaskInput,
  ): Promise<AssignmentResult> {
    const err = validateAssignInput(body);
    if (err) throw new BadRequestException(err);
    return this.assignments.assign(tenantId, body, actorOf(identity));
  }

  /** Create a Task in this tenant (optionally assigning it immediately). Never writes verified_state. */
  @Post('tasks')
  create(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity | undefined,
    @Body() body: CreateTaskInput,
  ): Promise<AssignmentResult> {
    const err = validateCreateTaskInput(body);
    if (err) throw new BadRequestException(err);
    return this.assignments.createTask(tenantId, normalizeCreateTaskInput(body), actorOf(identity));
  }
}
