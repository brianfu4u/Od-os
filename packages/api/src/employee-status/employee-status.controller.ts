import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import type { EmployeeStatusView, StatusBoardView, SubmitStatusClaimInput } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { EmployeeStatusService } from './employee-status.service';
import { validateSubmitStatusClaim, normalizeStatusClaim } from './employee-status.validation';

/**
 * T-04 · employee work-status endpoints. STAFF-ONLY (RolesGuard: a manager is a superset of staff
 * for staff routes; an unknown caller → 403). TenantGuard resolves the session tenant + identity;
 * the caller's OWN Staff id is derived server-side (never client-supplied).
 *
 * PRINCIPLE GUARANTEES enforced here + downstream:
 *   - A well-formed five-state claim is NEVER rejected/blocked and NEVER triggers rework. There is
 *     no "被拒 / 待审核 / 异常" response path.
 *   - The employee-facing responses carry the CLAIM layer ONLY. `EmployeeStatusView` has no
 *     verification_result / verification_confidence / LLM field — the field-projection guarantee
 *     (asserted at the key-name level in T-11).
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('staff')
@Controller('employee-status')
export class EmployeeStatusController {
  constructor(private readonly service: EmployeeStatusService) {}

  /** Submit a status claim for the caller's own Staff object. Never rejected for a valid five-state. */
  @Post('claims')
  submit(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity | undefined,
    @Body() body: SubmitStatusClaimInput,
  ): Promise<EmployeeStatusView> {
    const err = validateSubmitStatusClaim(body);
    if (err) throw new BadRequestException(err);
    const input = normalizeStatusClaim(body);
    return this.service.submit(tenantId, identity, input.claimedStatus, input.note, input.claimedAt);
  }

  /** The caller's own current status (CLAIM layer only — never verification fields). */
  @Get('me')
  me(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity | undefined,
  ): Promise<EmployeeStatusView> {
    return this.service.me(tenantId, identity);
  }

  /**
   * T-09 · D1-A · MANAGER-ONLY whole-roster status board (method-level @Roles('manager') OVERRIDES the
   * class-level 'staff' via reflector.getAllAndOverride). READ-ONLY snapshot: no write, no event, no
   * world-state mutation. Combines each Staff's CLAIM layer with the read-time freshness OBSERVATION;
   * carries NO verification/LLM/adjudication field. Not a decision surface — the three-state verdict
   * lives only in the assignments' decide() endpoint.
   */
  @Get('board')
  @Roles('manager')
  board(@TenantId() tenantId: string): Promise<StatusBoardView> {
    return this.service.board(tenantId);
  }
}
