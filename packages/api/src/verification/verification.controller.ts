import { Controller, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
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

  @Post('verifications/sweep')
  sweep(@TenantId() tenantId: string) {
    return this.verification.sweep(tenantId);
  }
}
