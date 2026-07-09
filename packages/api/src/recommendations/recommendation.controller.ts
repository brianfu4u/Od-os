import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { RecommendationStatus } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { RecommendationService } from './recommendation.service';

/** Who approved — recorded on every action_log row / event. Session-derived, never client-supplied. */
function actorOf(identity?: SessionIdentity): string {
  return identity?.managerId ?? identity?.staffId ?? identity?.staffHandle ?? 'manager';
}

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

  /**
   * Periodic sweep across all six domains — runs every agent over the tenant's candidate objects
   * and persists ranked cues. Declared before the ':id/*' routes so 'sweep' isn't read as an id.
   * A scheduler (or the demo/staff console) triggers this; advise-only, no world writes.
   */
  @Post('sweep')
  async sweep(@TenantId() tenantId: string) {
    const created = await this.recommendations.sweep(tenantId);
    return { created: created.length, ids: created };
  }

  /**
   * Human-in-the-loop. Approving runs the P2/S4 action write-back layer: if the cue's action is on
   * the low-risk INTERNAL whitelist it is executed (ontology write + append-only action_log), a
   * high-risk action is recorded but NEVER executed, and anything else records intent only.
   */
  @Post(':id/approve')
  approve(@TenantId() tenantId: string, @AuthIdentity() identity: SessionIdentity | undefined, @Param('id') id: string) {
    return this.recommendations.act(tenantId, id, 'approved', actorOf(identity));
  }

  /** Reverse a previously executed write-back and reopen the cue (reversible actions only). */
  @Post(':id/undo')
  undo(@TenantId() tenantId: string, @AuthIdentity() identity: SessionIdentity | undefined, @Param('id') id: string) {
    return this.recommendations.undo(tenantId, id, actorOf(identity));
  }

  /** The append-only action_log for a cue — what its approval did (executed / blocked / undone). */
  @Get(':id/actions')
  actions(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.recommendations.actionLog(tenantId, id);
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
