import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { StaffReportInput } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { ReportsService } from './reports.service';

/**
 * Inbound staff reports from the WeChat Mini Program (and, in dev, the harness).
 *
 * S0-3: TenantGuard resolves BOTH tenant and staff identity from the authenticated session.
 * In production the request body's `staffHandle`/`staffDisplayName` are ignored — the author is
 * the session's staff. In non-production the dev shim supplies the identity for local testing.
 */
@UseGuards(TenantGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  ingest(@TenantId() tenantId: string, @AuthIdentity() identity: SessionIdentity, @Body() body: StaffReportInput) {
    return this.reports.ingest(tenantId, body, identity);
  }
}
