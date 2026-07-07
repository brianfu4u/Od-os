import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { RecommendationStatus } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { RecommendationService } from './recommendation.service';

@UseGuards(TenantGuard)
@Controller('recommendations')
export class RecommendationController {
  constructor(private readonly recommendations: RecommendationService) {}

  /** Ranked Co-Pilot feed for the command center. */
  @Get()
  feed(@TenantId() tenantId: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    const s = (status as RecommendationStatus) || 'open';
    return this.recommendations.feed(tenantId, s, limit !== undefined ? Number(limit) : 20);
  }

  /** Operating tempo for the podium header. */
  @Get('tempo')
  tempo(@TenantId() tenantId: string) {
    return this.recommendations.tempo(tenantId);
  }

  // Human-in-the-loop: these record intent + emit an event; no world action runs in S3.
  @Post(':id/approve')
  approve(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.recommendations.act(tenantId, id, 'approved');
  }

  @Post(':id/dismiss')
  dismiss(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.recommendations.act(tenantId, id, 'dismissed');
  }

  @Post(':id/snooze')
  snooze(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.recommendations.act(tenantId, id, 'snoozed');
  }
}
