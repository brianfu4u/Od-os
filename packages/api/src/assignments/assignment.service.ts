import { Injectable, NotFoundException } from '@nestjs/common';
import type { AssignmentOverview, AssignmentResult, AssignTaskInput, CreateTaskInput } from '@clearview/shared';
import { AssignmentRepository } from './assignment.repository';

/**
 * Manager task assignment. Thin orchestration over the repository; the moat rules live in the
 * repository (writes only assignedTo + Task properties, never verified_state, tenant-scoped by RLS).
 * A null repository result — task/staff not resolvable in the caller's tenant — becomes a 404 so a
 * cross-tenant id is indistinguishable from a missing one.
 */
@Injectable()
export class AssignmentService {
  constructor(private readonly repo: AssignmentRepository) {}

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
}
