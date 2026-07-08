import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { OperatingTempo, RecommendationRecord, RecommendationStatus } from '@clearview/shared';
import { RealtimeService } from '../objects/realtime.service';
import { DomainEventBus } from '../events/domain-event-bus';
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
    const ranked = this.orchestrator.orchestrate(candidates);
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
    const ranked = this.orchestrator.orchestrate(candidates, 25);
    const created = await this.repo.persist(tenantId, ranked);
    for (const id of created) {
      this.realtime.publish({ kind: 'created', tenantId, objectId: id, type: 'Recommendation', at: new Date().toISOString() });
    }
    return created;
  }

  feed(tenantId: string, status: RecommendationStatus, limit: number): Promise<RecommendationRecord[]> {
    return this.repo.getFeed(tenantId, status, limit);
  }

  async act(tenantId: string, id: string, status: RecommendationStatus): Promise<RecommendationRecord> {
    const rec = await this.repo.setStatus(tenantId, id, status);
    if (!rec) throw new NotFoundException('recommendation not found');
    this.realtime.publish({ kind: 'updated', tenantId, objectId: id, type: 'Recommendation', at: new Date().toISOString() });
    return rec;
  }

  tempo(tenantId: string): Promise<OperatingTempo> {
    return this.repo.operatingTempo(tenantId);
  }
}
