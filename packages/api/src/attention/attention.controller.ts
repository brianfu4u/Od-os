import { Controller, Get, UseGuards } from '@nestjs/common';
import type { AttentionQueueView } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId } from '../tenant/tenant.decorator';
import { AttentionService } from './attention.service';

/**
 * T-06 · manager attention queue. MANAGER-ONLY, READ-ONLY.
 *
 * `GET /attention/queue` returns the current "worth a look" list, derived at read time from facts
 * already collected (status claims, scans, freshness, events). It is NOT a message feed and NOT an
 * adjudication entry point — there is deliberately no accept/dismiss route here and none of the
 * three-state `decide` semantics. RolesGuard enforces manager (a staff caller → 403). Reading the
 * queue changes no world state and produces no employee-visible event.
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('manager')
@Controller('attention')
export class AttentionController {
  constructor(private readonly service: AttentionService) {}

  @Get('queue')
  queue(@TenantId() tenantId: string): Promise<AttentionQueueView> {
    return this.service.queue(tenantId);
  }
}
