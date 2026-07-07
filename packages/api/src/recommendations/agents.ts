import type { DomainName, RecommendationCandidate } from '@clearview/shared';

/** What an agent reads to decide whether to propose. Gathered by the repository. */
export interface AgentContext {
  object: {
    id: string;
    type: string;
    properties: Record<string, unknown>;
    verifiedState: string | null;
    claimedState: string | null;
    confidence: number | null;
  };
  alert?: { id: string; triggered: string[]; severity: string; reason: string } | null;
  now: number;
}

/** A domain agent = deterministic detectors over the ontology. It ONLY proposes candidates. */
export interface DomainAgent {
  readonly domain: DomainName;
  propose(ctx: AgentContext): RecommendationCandidate[];
}

function label(ctx: AgentContext): string {
  const p = ctx.object.properties;
  return (typeof p.label === 'string' && p.label) || (typeof p.taskType === 'string' && p.taskType) || ctx.object.type;
}
const PATIENT_FLOW_TASKS = new Set(['room_turnover', 'pretest_done', 'dilation_started']);

export class PatientFlowAgent implements DomainAgent {
  readonly domain: DomainName = 'patient_flow';
  propose(ctx: AgentContext): RecommendationCandidate[] {
    const p = ctx.object.properties;
    const taskType = typeof p.taskType === 'string' ? p.taskType : '';
    if (ctx.object.type !== 'Task' || !PATIENT_FLOW_TASKS.has(taskType)) return [];
    const out: RecommendationCandidate[] = [];
    if (ctx.object.verifiedState === 'conflict') {
      out.push({
        domain: this.domain,
        sourceAgent: this.domain,
        title: `${label(ctx)}: completion unverified (conflict)`,
        why: ctx.alert?.reason ?? 'Claimed done, but evidence conflicts (missing required / timing).',
        evidence: [{ kind: 'verification', ref: ctx.object.id, note: ctx.alert?.reason ?? 'conflict' }],
        confidence: ctx.object.confidence ?? 0.5,
        proposedActions: [{ label: 'Request photo evidence', actionType: 'request_evidence', riskTier: 'low', needsApproval: false }],
        objectId: ctx.object.id,
        addresses: ctx.alert?.id,
        severity: 'high',
        impact: 2,
      });
    } else if (ctx.object.verifiedState === 'pending' && (ctx.alert?.triggered ?? []).includes('missing_required')) {
      out.push({
        domain: this.domain,
        sourceAgent: this.domain,
        title: `${label(ctx)}: pending — required evidence missing`,
        why: ctx.alert?.reason ?? 'Required evidence not yet attached.',
        evidence: [{ kind: 'verification', ref: ctx.object.id, note: 'required missing' }],
        confidence: ctx.object.confidence ?? 0.5,
        proposedActions: [{ label: 'Request evidence', actionType: 'request_evidence', riskTier: 'low', needsApproval: false }],
        objectId: ctx.object.id,
        addresses: ctx.alert?.id,
        severity: 'medium',
      });
    }
    return out;
  }
}

export class StaffAgent implements DomainAgent {
  readonly domain: DomainName = 'staff';
  propose(ctx: AgentContext): RecommendationCandidate[] {
    if (!(ctx.alert?.triggered ?? []).includes('overdue')) return [];
    const p = ctx.object.properties;
    const reassignTo = typeof p.reassignTo === 'string' ? p.reassignTo : undefined;
    return [
      {
        domain: this.domain,
        sourceAgent: this.domain,
        title: `${label(ctx)}: overdue — reassign or add support`,
        why: 'Task is past its due time and not yet verified.',
        evidence: [{ kind: 'alert', ref: ctx.alert?.id, note: 'overdue' }],
        confidence: 0.7,
        proposedActions: [{ label: 'Reassign staff', actionType: 'reassign', riskTier: 'low', needsApproval: true }],
        objectId: ctx.object.id,
        addresses: ctx.alert?.id,
        severity: 'medium',
        resourceKey: reassignTo ? `staff:${reassignTo}` : undefined,
      },
    ];
  }
}

export class InventoryAgent implements DomainAgent {
  readonly domain: DomainName = 'inventory';
  propose(ctx: AgentContext): RecommendationCandidate[] {
    const p = ctx.object.properties;
    if (ctx.object.type !== 'InventoryItem') return [];
    const onHand = typeof p.onHand === 'number' ? p.onHand : undefined;
    const reorderPoint = typeof p.reorderPoint === 'number' ? p.reorderPoint : undefined;
    if (onHand === undefined || reorderPoint === undefined || onHand > reorderPoint) return [];
    const name = typeof p.name === 'string' ? p.name : label(ctx);
    return [
      {
        domain: this.domain,
        sourceAgent: this.domain,
        title: `Stock low: reorder ${name}`,
        why: `On hand ${onHand} ≤ reorder point ${reorderPoint}.`,
        evidence: [{ kind: 'inventory', ref: ctx.object.id, note: `onHand=${onHand} reorderPoint=${reorderPoint}` }],
        confidence: 0.8,
        proposedActions: [{ label: 'Create reorder', actionType: 'reorder', riskTier: 'low', needsApproval: true }],
        objectId: ctx.object.id,
        severity: onHand === 0 ? 'high' : 'medium',
      },
    ];
  }
}

export const DEFAULT_AGENTS: DomainAgent[] = [new PatientFlowAgent(), new StaffAgent(), new InventoryAgent()];
