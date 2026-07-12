import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { RecommendationStatus } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId, AuthIdentity } from '../tenant/tenant.decorator';
import type { SessionIdentity } from '../auth/session.types';
import { RecommendationService } from './recommendation.service';

/** Who approved — recorded on every action_log row / event. Session-derived, never client-supplied. */
function actorOf(identity?: SessionIdentity): string {
  return identity?.managerId ?? identity?.staffId ?? identity?.staffHandle ?? 'manager';
}

/**
 * Command-center Co-Pilot. All the human-in-the-loop management actions (viewing the ranked feed and
 * operating tempo, approving/undoing write-backs, reading the per-cue action_log, dismissing and
 * snoozing) require a MANAGER session — enforced server-side per method by @Roles('manager').
 *
 * `sweep` is intentionally NOT manager-gated: it is an advise-only generator (no world writes) that a
 * scheduler or the demo/staff console triggers, and the staff console (StaffConsole.tsx) calls it.
 * Gating it would break that terminal affordance, so it stays open to any authenticated caller. If
 * the pilot wants sweeps to be manager/scheduler-only, add @Roles('manager') here + drop the staff
 * console's sweep button (flagged for review, not changed silently).
 */
@UseGuards(TenantGuard, RolesGuard)
@Controller('recommendations')
export class RecommendationController {
  constructor(private readonly recommendations: RecommendationService) {}

  /** Ranked Co-Pilot feed for the command center. */
  @Get()
  @Roles('manager')
  feed(@TenantId() tenantId: string, @Query('status') status?: string, @Query('limit') limit?: string) {
    const s = (status as RecommendationStatus) || 'open';
    return this.recommendations.feed(tenantId, s, limit !== undefined ? Number(limit) : 20);
  }

  /** Operating tempo for the podium header. */
  @Get('tempo')
  @Roles('manager')
  tempo(@TenantId() tenantId: string) {
    return this.recommendations.tempo(tenantId);
  }

  /**
   * Periodic sweep across all six domains — runs every agent over the tenant's candidate objects
   * and persists ranked cues. Declared before the ':id/*' routes so 'sweep' isn't read as an id.
   * A scheduler (or the demo/staff console) triggers this; advise-only, no world writes.
   * NOT manager-gated on purpose (see controller doc) — advise-only + used by the staff console.
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
  @Roles('manager')
  approve(@TenantId() tenantId: string, @AuthIdentity() identity: SessionIdentity | undefined, @Param('id') id: string) {
    return this.recommendations.act(tenantId, id, 'approved', actorOf(identity));
  }

  /** Reverse a previously executed write-back and reopen the cue (reversible actions only). */
  @Post(':id/undo')
  @Roles('manager')
  undo(@TenantId() tenantId: string, @AuthIdentity() identity: SessionIdentity | undefined, @Param('id') id: string) {
    return this.recommendations.undo(tenantId, id, actorOf(identity));
  }

  /** The append-only action_log for a cue — what its approval did (executed / blocked / undone). */
  @Get(':id/actions')
  @Roles('manager')
  actions(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.recommendations.actionLog(tenantId, id);
  }

  @Post(':id/dismiss')
  @Roles('manager')
  dismiss(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.recommendations.act(tenantId, id, 'dismissed');
  }

  @Post(':id/snooze')
  @Roles('manager')
  snooze(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.recommendations.act(tenantId, id, 'snoozed');
  }
}
