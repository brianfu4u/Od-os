import { BadRequestException, Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { ScanAck, SubmitScanInput } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { ScansService } from './scans.service';
import { validateSubmitScan } from './scans.validation';

/**
 * T-05 · patient-scan endpoint. STAFF-ONLY (RolesGuard; manager is a superset for staff routes).
 * The caller's own Staff id is derived server-side. A scan is a NEUTRAL contact fact: it is never a
 * business rejection and never blocks the employee — the only 400 is the shape rule "at least one
 * key" (mirroring the DB CHECK). An unresolvable code still stores as visit_link_status='unresolved'.
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('staff')
@Controller('scans')
export class ScansController {
  constructor(private readonly service: ScansService) {}

  @Post()
  submit(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity | undefined,
    @Body() body: SubmitScanInput,
  ): Promise<ScanAck> {
    const err = validateSubmitScan(body);
    if (err) throw new BadRequestException(err);
    return this.service.submit(tenantId, identity, body);
  }
}
