import { BadRequestException, Body, Controller, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { VerificationService } from './verification.service';

@UseGuards(TenantGuard)
@Controller()
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Post('objects/:id/verify')
  async verify(@TenantId() tenantId: string, @Param('id') id: string) {
    const result = await this.verification.verifyObject(tenantId, id);
    if (!result) throw new NotFoundException('object not found');
    return result;
  }

  /** P4/S8: manual verdict correction (human-in-the-loop) — feeds the learning loop. */
  @Post('verifications/correct')
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
  sweep(@TenantId() tenantId: string) {
    return this.verification.sweep(tenantId);
  }
}
