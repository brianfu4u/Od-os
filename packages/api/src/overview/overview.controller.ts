import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId } from '../tenant/tenant.decorator';
import { OverviewRepository } from './overview.repository';

/** Command-center overview — a management view. Requires a manager session (server-side enforced). */
@UseGuards(TenantGuard, RolesGuard)
@Roles('manager')
@Controller('overview')
export class OverviewController {
  constructor(private readonly repo: OverviewRepository) {}

  @Get()
  get(@TenantId() tenantId: string) {
    return this.repo.overview(tenantId);
  }
}
