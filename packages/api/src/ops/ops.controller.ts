import { Controller, Get, UseGuards } from '@nestjs/common';
import type { OpsSummary } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId } from '../tenant/tenant.decorator';
import { OpsService } from './ops.service';

/**
 * Manager-only, read-only ops view. TenantGuard resolves the session (tenant + role); RolesGuard
 * enforces manager server-side (a staff/unknown caller gets 403). The tenant section is scoped to
 * the caller's session tenant via RLS — cross-tenant ops data is never returned. Platform metrics
 * carry no tenant data or PHI.
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('manager')
@Controller('ops')
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('summary')
  summary(@TenantId() tenantId: string): Promise<OpsSummary> {
    return this.ops.summary(tenantId);
  }
}
