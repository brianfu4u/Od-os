import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import type {
  AttentionQueueView,
  RevealScanCodeRequest,
  RevealScanCodeResponse,
} from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { AttentionService } from './attention.service';

/**
 * T-06 · manager attention queue. MANAGER-ONLY, READ-ONLY.
 *
 * `GET /attention/queue` returns the current "worth a look" list, derived at read time from facts
 * already collected (status claims, scans, freshness, events). It is NOT a message feed and NOT an
 * adjudication entry point — there is deliberately no accept/dismiss route here and none of the
 * three-state `decide` semantics. RolesGuard enforces manager (a staff caller → 403). Reading the
 * queue changes no world state and produces no employee-visible event.
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('manager')
@Controller('attention')
export class AttentionController {
  constructor(private readonly service: AttentionService) {}

  @Get('queue')
  queue(@TenantId() tenantId: string): Promise<AttentionQueueView> {
    return this.service.queue(tenantId);
  }

  /**
   * P1-6-f · reveal the full raw patient scan code behind a masked queue item. MANAGER-ONLY (class
   * guard). Unlike the queue GET, this is a WRITE: it records one `sensitive.raw.accessed` access
   * event (who viewed the raw value, when) and returns the full code. Returns 200 with a `reason`
   * (never 404) when no code is available, so callers cannot probe record existence via status codes.
   */
  @Post('reveal-scan-code')
  @HttpCode(HttpStatus.OK)
  revealScanCode(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity | undefined,
    @Body() body: RevealScanCodeRequest,
  ): Promise<RevealScanCodeResponse> {
    const staffId = body?.staffId;
    if (typeof staffId !== 'string' || staffId.trim() === '') {
      throw new BadRequestException('staffId is required');
    }
    return this.service.revealScanCode(tenantId, staffId, identity?.managerId ?? null);
  }
}
