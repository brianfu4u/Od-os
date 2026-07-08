import { Controller, Get, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { OverviewRepository } from './overview.repository';

@UseGuards(TenantGuard)
@Controller('overview')
export class OverviewController {
  constructor(private readonly repo: OverviewRepository) {}

  @Get()
  get(@TenantId() tenantId: string) {
    return this.repo.overview(tenantId);
  }
}
