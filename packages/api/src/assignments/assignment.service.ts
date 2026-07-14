import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssignmentOverview,
  AssignmentResult,
  AssignTaskInput,
  CreateTaskInput,
  TaskDecisionInput,
  TaskDecisionResult,
} from '@clearview/shared';
import { RealtimeService } from '../objects/realtime.service';
import {
  AssignmentRepository,
  FlowAlreadyClosedError,
  InvalidRejectionReasonError,
} from './assignment.repository';

/**
 * Manager task assignment. Thin orchestration over the repository; the moat rules live in the
 * repository (writes only assignedTo + Task properties, never verified_state, tenant-scoped by RLS).
 * A null repository result — task/staff not resolvable in the caller's tenant — becomes a 404 so a
 * cross-tenant id is indistinguishable from a missing one.
 */
@Injectable()
export class AssignmentService {
  constructor(
    private readonly repo: AssignmentRepository,
    private readonly realtime: RealtimeService,
  ) {}

  overview(tenantId: string): Promise<AssignmentOverview> {
    return this.repo.overview(tenantId);
  }

  async assign(tenantId: string, input: AssignTaskInput, actor: string): Promise<AssignmentResult> {
    const res = await this.repo.assign(tenantId, input.taskId, input.staffId, actor);
    if (!res) throw new NotFoundException('task or staff not found in this clinic');
    return res;
  }

  async createTask(tenantId: string, input: CreateTaskInput, actor: string): Promise<AssignmentResult> {
    const res = await this.repo.createTask(tenantId, input, actor);
    if (!res) throw new NotFoundException('assignee staff not found in this clinic');
    return res;
  }

  /**
   * The manager's single-authority three-state decision (APPROVE / REJECT / SHELVE). After the atomic
   * write commits, publish the real-time signal so the assigned employee's task list refreshes:
   *   - APPROVE / REJECT are employee-visible → publish an `updated` Task event (the client refetches
   *     /tasks/mine and sees the closed state, or the rejection reason).
   *   - SHELVE is silent → no employee signal (the task simply stays in the manager's queue).
   * The rejection REASON itself is carried on the persisted task (read via /tasks/mine), not in the
   * thin SSE payload — the SSE only nudges the client to refetch.
   */
  async decide(tenantId: string, taskId: string, input: TaskDecisionInput, actor: string): Promise<TaskDecisionResult> {
    let outcome;
    try {
      outcome = await this.repo.decide(tenantId, taskId, input, actor);
    } catch (err) {
      if (err instanceof FlowAlreadyClosedError) throw new ConflictException('this task flow is already closed');
      if (err instanceof InvalidRejectionReasonError) throw new BadRequestException('a rejection requires a valid rejectionReasonCategory');
      throw err;
    }
    if (!outcome) throw new NotFoundException('task not found in this clinic');
    if (outcome.notifyEmployee) {
      this.realtime.publish({
        kind: 'updated',
        tenantId,
        objectId: taskId,
        type: 'Task',
        at: new Date().toISOString(),
      });
    }
    return outcome.result;
  }
}
