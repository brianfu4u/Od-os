import { Injectable } from '@nestjs/common';
import type { AttentionQueueView } from '@clearview/shared';
import { AttentionRepository } from './attention.repository';
import { dedupForDisplay } from './rules/attention-dedup';

/**
 * T-06 attention-queue service. Read-time pipeline:
 *   1) repository generates candidates from current facts (pure read — writes nothing);
 *   2) the service applies DISPLAY-layer dedup/cooldown (collapse same employee+kind) purely to keep
 *      the manager view uncluttered — this is presentation only.
 *
 * There is no accept/dismiss here and no world-state mutation — the queue is strictly read-only. A
 * finding that no longer holds simply isn't generated on the next read (auto-dequeue), so the queue
 * needs no stored table and no explicit eviction step.
 *
 * P1-5: the former read-time audit write (T-10 `attention.candidate.generated` per candidate) was
 * intentionally removed — see AttentionRepository.generate() for the rationale.
 */
@Injectable()
export class AttentionService {
  constructor(private readonly repo: AttentionRepository) {}

  async queue(tenantId: string): Promise<AttentionQueueView> {
    const { candidates } = await this.repo.generate(tenantId);
    const items = dedupForDisplay(candidates);
    return { items };
  }
}
