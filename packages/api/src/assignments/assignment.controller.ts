import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import type {
  AssignmentOverview,
  AssignmentResult,
  AssignTaskInput,
  CreateTaskInput,
  TaskDecisionInput,
  TaskDecisionResult,
} from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { AssignmentService } from './assignment.service';
import {
  validateAssignInput,
  validateCreateTaskInput,
  validateDecisionInput,
  normalizeCreateTaskInput,
  isUuid,
} from './assignment.validation';

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

  /**
   * The manager's single-authority THREE-STATE decision on a task's flow. This is the ONLY path that
   * moves a flow's lifecycle — there is no automatic escalation or auto-resubmission. APPROVE closes
   * the flow (terminal); REJECT keeps it open (same flow) with a structured reason the employee sees;
   * SHELVE leaves it in the queue silently. Manager-only (RolesGuard); actor is session-derived.
   */
  @Post('tasks/:id/decide')
  decide(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity | undefined,
    @Param('id') id: string,
    @Body() body: TaskDecisionInput,
  ): Promise<TaskDecisionResult> {
    if (!isUuid(id)) throw new BadRequestException('task id (uuid) is required');
    const err = validateDecisionInput(body);
    if (err) throw new BadRequestException(err);
    return this.assignments.decide(tenantId, id, body, actorOf(identity));
  }
}
