import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { ActionLogRecord, OperatingTempo, RecommendationRecord, RecommendationStatus } from '@clearview/shared';
import { RealtimeService } from '../objects/realtime.service';
import { DomainEventBus } from '../events/domain-event-bus';
import type { ExecutionOutcome } from '../actions/actions.types';
import { LearningRepository } from '../learning/learning.repository';
import { RecommendationRepository } from './recommendation.repository';
import { DEFAULT_AGENTS, type DomainAgent } from './agents';
import { Orchestrator } from './orchestrator';

@Injectable()
export class RecommendationService {
  // Deterministic first; swapping `orchestrator`/`agents` is the seam for an LLM re-ranker.
  private readonly agents: DomainAgent[] = DEFAULT_AGENTS;
  private readonly orchestrator = new Orchestrator();

  constructor(
    private readonly repo: RecommendationRepository,
    private readonly realtime: RealtimeService,
    @Optional() private readonly bus?: DomainEventBus,
    // P4/S8: read learned per-domain priority penalties. Optional + default so hand-wired tests work.
    @Optional() private readonly learning: LearningRepository = new LearningRepository(),
  ) {
    // Event seam: a completed verification (conflict/pending/overdue…) fans out to the agents.
    this.bus?.on(
      'verification.completed',
      (e) => this.runForObject(e.tenantId, e.objectId).then(() => undefined),
      'recommendation.pipeline',
    );
  }

  /** Run domain agents for one object, de-conflict/rank, and persist the surviving cues. */
  async runForObject(tenantId: string, objectId: string): Promise<string[]> {
    const ctx = await this.repo.gatherContext(tenantId, objectId);
    if (!ctx) return [];
    const candidates = this.agents.flatMap((agent) => agent.propose(ctx));
    if (candidates.length === 0) return [];
    const penalties = await this.learning.getDomainPriorityPenalties(tenantId);
    const ranked = this.orchestrator.orchestrate(candidates, 5, penalties);
    const created = await this.repo.persist(tenantId, ranked);
    for (const id of created) {
      this.realtime.publish({ kind: 'created', tenantId, objectId: id, type: 'Recommendation', at: new Date().toISOString() });
    }
    return created;
  }

  /**
   * Periodic sweep: run every domain agent over ALL candidate objects in the tenant, de-conflict
   * and rank across all six domains, and persist the surviving cues. This is how the time-based
   * domains (financial/marketing/equipment) surface — they don't wait on a verification event.
   * A higher cap than the live per-object feed so a full scan can show every domain at once.
   */
  async sweep(tenantId: string): Promise<string[]> {
    const contexts = await this.repo.gatherSweepContexts(tenantId);
    const candidates = contexts.flatMap((ctx) => this.agents.flatMap((agent) => agent.propose(ctx)));
    if (candidates.length === 0) return [];
    const penalties = await this.learning.getDomainPriorityPenalties(tenantId);
    const ranked = this.orchestrator.orchestrate(candidates, 25, penalties);
    const created = await this.repo.persist(tenantId, ranked);
    for (const id of created) {
      this.realtime.publish({ kind: 'created', tenantId, objectId: id, type: 'Recommendation', at: new Date().toISOString() });
    }
    return created;
  }

  feed(tenantId: string, status: RecommendationStatus, limit: number): Promise<RecommendationRecord[]> {
    return this.repo.getFeed(tenantId, status, limit);
  }

  /**
   * Human-in-the-loop action. `approved` runs the P2/S4 write-back layer (executes a whitelisted
   * internal action or records intent); `dismissed`/`snoozed` record intent only. `actor` is the
   * approving manager (audited on every write).
   */
  async act(tenantId: string, id: string, status: RecommendationStatus, actor = 'manager'): Promise<RecommendationRecord> {
    if (status === 'approved') return this.approve(tenantId, id, actor);
    const rec = await this.repo.setStatus(tenantId, id, status);
    if (!rec) throw new NotFoundException('recommendation not found');
    this.realtime.publish({ kind: 'updated', tenantId, objectId: id, type: 'Recommendation', at: new Date().toISOString() });
    return rec;
  }

  /** Approve a cue and execute its write-back if whitelisted (else record intent). */
  async approve(tenantId: string, id: string, actor = 'manager'): Promise<RecommendationRecord> {
    const { record, outcome } = await this.repo.approveAndExecute(tenantId, id, actor);
    if (!record) throw new NotFoundException('recommendation not found');
    this.publishOutcome(tenantId, id, outcome);
    return record;
  }

  /** Reverse a cue's executed write-back and reopen it. */
  async undo(tenantId: string, id: string, actor = 'manager'): Promise<RecommendationRecord> {
    const { record, outcome } = await this.repo.undoAction(tenantId, id, actor);
    if (!record) throw new NotFoundException('recommendation not found');
    this.publishOutcome(tenantId, id, outcome);
    return record;
  }

  /** The append-only action_log for a cue — what its approval did. */
  actionLog(tenantId: string, id: string): Promise<ActionLogRecord[]> {
    return this.repo.getActionLog(tenantId, id);
  }

  private publishOutcome(tenantId: string, id: string, outcome: ExecutionOutcome | null): void {
    const at = new Date().toISOString();
    this.realtime.publish({ kind: 'updated', tenantId, objectId: id, type: 'Recommendation', at });
    if (outcome?.targetObjectId) this.realtime.publish({ kind: 'updated', tenantId, objectId: outcome.targetObjectId, type: 'Object', at });
    if (outcome?.createdObjectId) this.realtime.publish({ kind: 'created', tenantId, objectId: outcome.createdObjectId, type: 'Task', at });
  }

  tempo(tenantId: string): Promise<OperatingTempo> {
    return this.repo.operatingTempo(tenantId);
  }
}
