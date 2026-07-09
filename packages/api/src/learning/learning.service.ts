import { Injectable } from '@nestjs/common';
import type { LearningAuditRecord, LearningFeedbackRecord, LearningRunResult } from '@clearview/shared';
import { LearningRepository } from './learning.repository';

/** P4/S8 learning loop: run/rollback the deterministic learner and read its append-only trail. */
@Injectable()
export class LearningService {
  constructor(private readonly repo: LearningRepository) {}

  run(tenantId: string): Promise<LearningRunResult> {
    return this.repo.run(tenantId);
  }

  rollback(tenantId: string): Promise<{ runId: string | null; reverted: number }> {
    return this.repo.rollback(tenantId);
  }

  feedback(tenantId: string, limit?: number): Promise<LearningFeedbackRecord[]> {
    return this.repo.listFeedback(tenantId, limit);
  }

  audit(tenantId: string, limit?: number): Promise<LearningAuditRecord[]> {
    return this.repo.listAudit(tenantId, limit);
  }
}
