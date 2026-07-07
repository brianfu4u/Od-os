import { Inject, Injectable } from '@nestjs/common';
import type { VerificationResult } from '@clearview/shared';
import { RealtimeService } from '../objects/realtime.service';
import { VerificationRepository } from './verification.repository';
import { SCORER, type Scorer } from './scorer';

@Injectable()
export class VerificationService {
  constructor(
    @Inject(SCORER) private readonly scorer: Scorer,
    private readonly repo: VerificationRepository,
    private readonly realtime: RealtimeService,
  ) {}

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
    return outcome.result;
  }

  /** Time-based sweep: re-verify not-yet-verified Tasks so overdue/missing triggers fire. */
  async sweep(tenantId: string): Promise<{ swept: number }> {
    const ids = await this.repo.findSweepCandidates(tenantId);
    for (const id of ids) await this.verifyObject(tenantId, id);
    return { swept: ids.length };
  }
}
