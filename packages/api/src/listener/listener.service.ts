/**
 * LLM1 · Listen layer service. Subscribes to the report event stream, runs the pluggable listener
 * (DeepSeek or heuristic), and applies ONLY what the moat allows.
 *
 * ⛔ MOAT: the sole state write LLM1 ever performs is setting a Task's claimed_state via
 * `applyClaim()`, which constructs an UpdateObjectInput that — by construction — carries only
 * `claimedState` + `properties`. It NEVER sets verifiedState/confidence. Setting claimed_state
 * publishes `object.state.claimed`, which drives the DETERMINISTIC cross-verification engine (S2);
 * that engine, not LLM1, decides `verified`. Low confidence or an unresolvable claim → we record it
 * as pending and touch no state. There is a test asserting LLM1 never writes verified.
 *
 * Non-blocking: the event handler schedules processing and returns immediately so report ingestion
 * is never slowed by an LLM call. `idle()` lets tests await in-flight work deterministically.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { RecommendationCandidate, Severity } from '@clearview/shared';
import { DomainEventBus } from '../events/domain-event-bus';
import { ObjectsService } from '../objects/objects.service';
import { RecommendationService } from '../recommendations/recommendation.service';
import { LlmListenerRepository } from './listener.repository';
import { toDomainName } from './listen-lex';
import { PROMPT_VERSIONS } from './prompts';
import {
  LLM_LISTENER,
  type ListenAnalysis,
  type ListenLocale,
  type ListenSummary,
  type LlmListenerPort,
} from './listener.types';

const CLAIM_MIN_CONFIDENCE = 0.6;

@Injectable()
export class LlmListenerService {
  private readonly logger = new Logger(LlmListenerService.name);
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    @Inject(LLM_LISTENER) private readonly listener: LlmListenerPort,
    private readonly repo: LlmListenerRepository,
    private readonly objects: ObjectsService,
    @Optional() private readonly recommendations?: RecommendationService,
    @Optional() private readonly bus?: DomainEventBus,
  ) {
    this.logger.log(`LLM1 listen layer active — adapter: ${this.listener.name}`);
    // Async, non-blocking: schedule processing and return instantly so /reports isn't slowed.
    this.bus?.on(
      'report.received',
      (e) => {
        this.track(this.process(e.tenantId, e.objectId));
      },
      'llm1.listen',
    );
  }

  /** Await all in-flight background analyses — for deterministic tests/smoke. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private track(p: Promise<unknown>): void {
    const wrapped = p.catch((err) => this.logger.error(`listen background task failed: ${err instanceof Error ? err.message : String(err)}`));
    this.pending.add(wrapped);
    void wrapped.finally(() => this.pending.delete(wrapped));
  }

  /**
   * Analyze one Communication and apply the moat-allowed effects. Returns the analysis (or null if
   * the communication is gone). Never throws — failures are audited as 'error'.
   */
  async process(tenantId: string, communicationId: string): Promise<ListenAnalysis | null> {
    const comm = await this.repo.loadCommunication(tenantId, communicationId);
    if (!comm) return null;

    const locale = (comm.locale as ListenLocale) || undefined;
    let analysis: ListenAnalysis | null = null;
    let appliedObjectId: string | null = null;
    let appliedAction = 'classified_only';

    try {
      analysis = await this.listener.analyze({
        text: comm.text,
        reportType: comm.reportType,
        fields: comm.fields,
        hasAttachments: comm.hasAttachments,
        hasScans: comm.hasScans,
        locale,
      });

      // 1) Annotate the Communication with the classification (safe: no state fields touched).
      await this.objects.update(tenantId, communicationId, {
        properties: {
          llm: {
            adapter: this.listener.name,
            promptVersion: PROMPT_VERSIONS.analyze,
            classification: analysis.classification,
            claim: analysis.claim,
            confidence: analysis.confidence,
            summary: analysis.summary,
            locale: analysis.locale,
            at: new Date().toISOString(),
          },
        },
      });

      // 2) Apply the claim — the ONLY state write, and only claimed_state.
      if (analysis.claim && analysis.claim.claimedState) {
        if (analysis.confidence < CLAIM_MIN_CONFIDENCE) {
          appliedAction = 'pending_low_confidence';
        } else {
          const resolved = await this.repo.resolveTaskForClaim(tenantId, analysis.claim, { create: true });
          if (resolved) {
            await this.applyClaim(tenantId, resolved.objectId, analysis.claim.claimedState, communicationId);
            appliedObjectId = resolved.objectId;
            appliedAction = 'claim_applied';
          } else {
            appliedAction = 'claim_unresolved';
          }
        }
      } else if (analysis.candidateCues.length > 0) {
        appliedAction = 'cues_only';
      }

      // 3) Candidate cues → the EXISTING S3 orchestrator (dedup / rank / human-in-the-loop).
      if (analysis.candidateCues.length > 0 && this.recommendations) {
        const subject = appliedObjectId ?? communicationId;
        const candidates = analysis.candidateCues.map((cue): RecommendationCandidate => ({
          domain: toDomainName(cue.domain),
          sourceAgent: toDomainName(cue.domain),
          title: cue.title,
          why: cue.detail ?? analysis!.summary,
          evidence: [{ kind: 'llm1_listen', ref: communicationId, note: 'proposed by LLM1 listen layer' }],
          confidence: analysis!.confidence,
          proposedActions: [],
          objectId: subject,
          severity: toSeverity(cue.severity),
          impact: 1,
        }));
        try {
          await this.recommendations.ingestCandidates(tenantId, candidates);
        } catch (err) {
          this.logger.warn(`ingestCandidates failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      await this.audit(tenantId, comm, analysis, appliedObjectId, appliedAction);
      return analysis;
    } catch (err) {
      this.logger.error(`process failed for communication ${communicationId}: ${err instanceof Error ? err.message : String(err)}`);
      await this.audit(tenantId, comm, analysis, appliedObjectId, 'error').catch(() => undefined);
      return analysis;
    }
  }

  /**
   * The ONE guarded state write. Constructs an update payload that can only ever carry claimedState
   * + properties — there is deliberately no way to pass verifiedState from here. Setting the claim
   * emits object.state.claimed → deterministic verification runs and owns the verdict.
   */
  private async applyClaim(tenantId: string, objectId: string, claimedState: string, communicationId: string): Promise<void> {
    await this.objects.update(tenantId, objectId, {
      claimedState,
      properties: { claimedAt: new Date().toISOString(), claimedBy: communicationId },
    });
  }

  private audit(
    tenantId: string,
    comm: { id: string; text: string; locale: string | null },
    analysis: ListenAnalysis | null,
    appliedObjectId: string | null,
    appliedAction: string,
  ): Promise<void> {
    return this.repo.audit(tenantId, {
      communicationId: comm.id,
      objectId: appliedObjectId,
      listener: this.listener.name,
      model: this.listener.name === 'deepseek' ? process.env.DEEPSEEK_MODEL || 'deepseek-chat' : null,
      promptVersion: PROMPT_VERSIONS.analyze,
      locale: analysis?.locale ?? comm.locale ?? null,
      eventType: analysis?.classification.eventType ?? null,
      domain: analysis?.classification.domain ?? null,
      severity: analysis?.classification.severity ?? null,
      taskType: analysis?.classification.taskType ?? null,
      claimedState: analysis?.claim?.claimedState ?? null,
      confidence: analysis?.confidence ?? null,
      appliedAction,
      input: comm.text,
      output: analysis ?? {},
    });
  }

  /** Summarize what LLM1 heard over a window (per shift / day / domain / terminal). */
  async summarize(
    tenantId: string,
    opts: { scope?: string; hours?: number; domain?: string; locale?: ListenLocale },
  ): Promise<ListenSummary> {
    const hours = Math.min(Math.max(opts.hours ?? 12, 1), 168);
    const scope = opts.scope ?? (opts.domain ? `domain:${opts.domain}` : 'shift');
    const events = await this.repo.gatherAnalyses(tenantId, hours, opts.domain);
    return this.listener.summarize({ scope, locale: opts.locale ?? 'zh', periodHours: hours, events });
  }
}

function toSeverity(s: 'info' | 'low' | 'medium' | 'high'): Severity {
  return s === 'info' ? 'low' : s;
}
