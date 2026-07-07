import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { StaffReportInput } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { ReportsService } from './reports.service';

/**
 * Inbound staff reports from the WeChat Mini Program (and, for now, the dev harness).
 *
 * Auth today reuses the DEV-ONLY tenant guard (X-Tenant-Id, disabled in production).
 * TODO(S0-3): the tenant AND the staff identity must come from the wx.login/openid
 * session — neither may be trusted from the client in production.
 */
@UseGuards(TenantGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  ingest(@TenantId() tenantId: string, @Body() body: StaffReportInput) {
    return this.reports.ingest(tenantId, body);
  }
}
