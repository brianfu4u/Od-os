import { BadRequestException, Body, Controller, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId } from '../tenant/tenant.decorator';
import { VerificationService } from './verification.service';

/**
 * The management verification actions — a manual verdict correction (human-in-the-loop) and a
 * tenant-wide re-verification sweep — require a MANAGER session (server-side, per method).
 *
 * `POST objects/:id/verify` is intentionally NOT manager-gated: it re-runs the DETERMINISTIC S2
 * engine on a single object (it computes verified_state from evidence — it does not accept a
 * human-supplied verdict), and the staff console (StaffConsole.tsx) calls it to show live
 * cross-verification. It stays open to any authenticated caller; correcting a verdict by hand
 * (which overrides the engine) is the privileged action and IS manager-gated.
 */
@UseGuards(TenantGuard, RolesGuard)
@Controller()
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Post('objects/:id/verify')
  async verify(@TenantId() tenantId: string, @Param('id') id: string) {
    const result = await this.verification.verifyObject(tenantId, id);
    if (!result) throw new NotFoundException('object not found');
    return result;
  }

  /** P4/S8: manual verdict correction (human-in-the-loop) — feeds the learning loop. Manager-only. */
  @Post('verifications/correct')
  @Roles('manager')
  async correct(
    @TenantId() tenantId: string,
    @Body() body: { objectId?: string; verifiedState?: string; reason?: string },
  ) {
    if (!body?.objectId || !body?.verifiedState) {
      throw new BadRequestException('objectId and verifiedState are required');
    }
    const res = await this.verification.correct(tenantId, body.objectId, body.verifiedState, body.reason ?? '');
    if (!res) throw new NotFoundException('object not found');
    return res;
  }

  @Post('verifications/sweep')
  @Roles('manager')
  sweep(@TenantId() tenantId: string) {
    return this.verification.sweep(tenantId);
  }
}
