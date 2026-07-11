import { Controller, Get, UseGuards } from '@nestjs/common';
import type { MyTaskSummary } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { TasksService } from './tasks.service';

/**
 * T5 · staff terminal "My tasks". Read-only, tenant-guarded. The session identity (from the same
 * guard that authenticates /reports) scopes the list to the caller's own assigned Tasks — the server
 * never trusts a client-supplied staff id.
 */
@UseGuards(TenantGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get('mine')
  mine(@TenantId() tenantId: string, @AuthIdentity() identity: SessionIdentity): Promise<MyTaskSummary[]> {
    return this.tasks.listMine(tenantId, identity);
  }
}
