import { Inject, Injectable, Optional } from '@nestjs/common';
import type { VerificationResult } from '@clearview/shared';
import { RealtimeService } from '../objects/realtime.service';
import { DomainEventBus } from '../events/domain-event-bus';
import { VerificationRepository } from './verification.repository';
import { SCORER, type Scorer } from './scorer';

@Injectable()
export class VerificationService {
  constructor(
    @Inject(SCORER) private readonly scorer: Scorer,
    private readonly repo: VerificationRepository,
    private readonly realtime: RealtimeService,
    @Optional() private readonly bus?: DomainEventBus,
  ) {
    // Event seam (absorbs the deferred S2-Q2 wire): a new claim → auto-verify.
    this.bus?.on(
      'object.state.claimed',
      (e) => this.verifyObject(e.tenantId, e.objectId).then(() => undefined),
      'verification.auto-verify',
    );
  }

  /** Re-entrant, idempotent (re)verification of one object. Appends a ledger row each run. */
  async verifyObject(tenantId: string, objectId: string): Promise<VerificationResult | null> {
    const outcome = await this.repo.verify(tenantId, objectId, this.scorer);
    if (!outcome) return null;
    // Publish AFTER the tx commits so the command center reacts to committed truth.
    this.realtime.publish({
      kind: 'verified',
      tenantId,
      objectId,
      type: outcome.objectType,
      at: new Date().toISOString(),
    });
    // Fan out to the domain agents (S3): verified/conflict/overdue → ranked cues.
    await this.bus?.publish({
      type: 'verification.completed',
      tenantId,
      objectId,
      payload: { verifiedState: outcome.result.verifiedState, triggered: outcome.result.triggered },
    });
    return outcome.result;
  }

  /** Time-based sweep: re-verify not-yet-verified Tasks so overdue/missing triggers fire. */
  async sweep(tenantId: string): Promise<{ swept: number }> {
    const ids = await this.repo.findSweepCandidates(tenantId);
    for (const id of ids) await this.verifyObject(tenantId, id);
    return { swept: ids.length };
  }
}
