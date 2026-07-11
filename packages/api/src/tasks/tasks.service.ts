import { Injectable } from '@nestjs/common';
import type { MyTaskSummary } from '@clearview/shared';
import { TasksRepository } from './tasks.repository';
import type { SessionIdentity } from '../auth/session.types';

/** T5 · read-only "my tasks" projection. No writes; the verdict is the Task's own verified_state (S2). */
@Injectable()
export class TasksService {
  constructor(private readonly repo: TasksRepository) {}

  listMine(tenantId: string, identity: SessionIdentity | undefined): Promise<MyTaskSummary[]> {
    return this.repo.listMine(tenantId, identity);
  }
}
