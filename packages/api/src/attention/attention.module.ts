import { Module } from '@nestjs/common';
import { AttentionController } from './attention.controller';
import { AttentionService } from './attention.service';
import { AttentionRepository } from './attention.repository';
import { SensitivePayloadsRepository } from '../retention/sensitive-payloads.repository';

/**
 * T-06/T-07/T-10 · manager attention queue (feat/attention-p0, Stage 3). Additive, READ-ONLY module.
 * It derives a "worth a look" list at read time from facts already collected in stage 1/2, and
 * audit-logs every generated candidate to the shared append-only events ledger (T-10). It NEVER
 * mutates the objects triplet, claimed_status, or flow_id/flow_state, and produces NO
 * employee-visible event. Per the stage-3 decision, it does NOT broadcast over SSE (no ObjectsModule
 * import needed), keeping the surface minimal — the manager client pulls the queue on demand.
 */
@Module({
  controllers: [AttentionController],
  // SensitivePayloadsRepository is provided so the reveal read path resolves the raw scan code via
  // the redactable side-store (P1-6-d D-choice-1), never the append-only source column (KI-001).
  providers: [AttentionService, AttentionRepository, SensitivePayloadsRepository],
})
export class AttentionModule {}
