import type { DomainName, RecommendationCandidate } from '@clearview/shared';
import { DOMAIN_THRESHOLDS } from './domain-config';

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
  /** Optional cross-object signals the sweep can populate (undefined on the per-object event path). */
  related?: { usageScan?: boolean };
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
function minutesSince(iso: unknown, now: number): number | null {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : (now - t) / 60000;
}
function numProp(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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
    } else if (ctx.object.verifiedState === 'pending' && (ctx.alert?.triggered ?? []).includes('overdue')) {
      // Soft nudge: a pending task only earns a cue once it is OVERDUE. Plain "required
      // evidence missing" (no anomaly, not overdue) stays quiet — it is normal in-flight work.
      out.push({
        domain: this.domain,
        sourceAgent: this.domain,
        title: `${label(ctx)}: overdue and still pending`,
        why: ctx.alert?.reason ?? 'Past its due time with required evidence not yet attached.',
        evidence: [{ kind: 'verification', ref: ctx.object.id, note: 'overdue + required missing' }],
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
        proposedActions: [{ label: 'Reassign task', actionType: 'reassign_task', riskTier: 'low', needsApproval: true }],
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
    const onHand = numProp(p, 'onHand');
    const reorderPoint = numProp(p, 'reorderPoint');
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
        proposedActions: [{ label: 'Create reorder task', actionType: 'inventory_reorder', riskTier: 'low', needsApproval: true }],
        objectId: ctx.object.id,
        severity: onHand === 0 ? 'high' : 'medium',
      },
    ];
  }
}

/**
 * Financial: money that has been claimed but not reconciled, and claims that will bounce for a
 * missing field. Both are cash-flow risks a manager wants surfaced before month-end / payer denial.
 */
export class FinancialAgent implements DomainAgent {
  readonly domain: DomainName = 'financial';
  propose(ctx: AgentContext): RecommendationCandidate[] {
    const p = ctx.object.properties;
    const cfg = DOMAIN_THRESHOLDS.financial;
    const out: RecommendationCandidate[] = [];

    // Unposted: collected but not posted to the ledger beyond the reconcile window.
    if ((ctx.object.type === 'Invoice' || ctx.object.type === 'Payment') && ctx.object.claimedState === 'collected' && ctx.object.verifiedState !== 'posted') {
      const ageMin = minutesSince(p.claimedAt ?? p.at, ctx.now);
      if (ageMin === null || ageMin >= cfg.unpostedWindowMin) {
        out.push({
          domain: this.domain,
          sourceAgent: this.domain,
          title: `${label(ctx)}: collected but unposted — reconcile`,
          why: 'Marked collected but not yet posted to the ledger; reconcile before close.',
          evidence: [{ kind: 'financial', ref: ctx.object.id, note: 'claimed=collected, verified≠posted' }],
          confidence: 0.8,
          proposedActions: [{ label: 'Reconcile posting', actionType: 'reconcile', riskTier: 'low', needsApproval: true }],
          objectId: ctx.object.id,
          severity: 'medium',
        });
      }
    }

    // Claim missing a required field (e.g. referral) → will delay reimbursement.
    if (ctx.object.type === 'Claim') {
      const missing = Array.isArray(p.missingFields) ? (p.missingFields as unknown[]).filter((f) => typeof f === 'string') : [];
      if (missing.length > 0) {
        out.push({
          domain: this.domain,
          sourceAgent: this.domain,
          title: `Claim ${label(ctx)}: missing ${missing.join(', ')} — will delay reimbursement`,
          why: `Payer will deny/hold: required field(s) missing — ${missing.join(', ')}.`,
          evidence: [{ kind: 'claim', ref: ctx.object.id, note: `missing: ${missing.join(', ')}` }],
          confidence: 0.9,
          // request_info is an internal nudge (records intent); submit_claim is an EXTERNAL side
          // effect → high risk, never auto-executed (proves the whitelist gate).
          proposedActions: [
            { label: 'Request missing info', actionType: 'request_info', riskTier: 'low', needsApproval: false },
            { label: 'Submit claim to payer', actionType: 'submit_claim', riskTier: 'high', needsApproval: true },
          ],
          objectId: ctx.object.id,
          severity: 'high',
        });
      }
    }
    return out;
  }
}

/**
 * Marketing: reputation + pipeline hygiene. A low review left unanswered past SLA compounds fast;
 * a lead with no follow-up decays. Advise-only — drafting/assigning is intent, never an auto-send.
 */
export class MarketingAgent implements DomainAgent {
  readonly domain: DomainName = 'marketing';
  propose(ctx: AgentContext): RecommendationCandidate[] {
    const p = ctx.object.properties;
    const cfg = DOMAIN_THRESHOLDS.marketing;
    const out: RecommendationCandidate[] = [];

    if (ctx.object.type === 'Review') {
      const rating = numProp(p, 'rating');
      const slaMin = numProp(p, 'responseSlaMin') ?? cfg.reviewResponseSlaMin;
      const responded = typeof p.respondedAt === 'string' && p.respondedAt.length > 0;
      const ageMin = minutesSince(p.at ?? p.createdAt, ctx.now);
      if (rating !== undefined && rating <= cfg.negativeRatingMax && !responded && ageMin !== null && ageMin > slaMin) {
        out.push({
          domain: this.domain,
          sourceAgent: this.domain,
          title: `${rating}★ review ${Math.round(ageMin)}m ago, unanswered (SLA ${slaMin}m)`,
          why: 'Negative review is past the response SLA; unanswered reviews compound reputation risk.',
          evidence: [{ kind: 'review', ref: ctx.object.id, note: `rating ${rating}, age ${Math.round(ageMin)}m` }],
          confidence: 0.85,
          // flag_review_followup creates an INTERNAL follow-up task (whitelisted); publicly replying
          // to the reviewer is an EXTERNAL side effect → high risk, never auto-executed.
          proposedActions: [
            { label: 'Create follow-up task', actionType: 'flag_review_followup', riskTier: 'low', needsApproval: true },
            { label: 'Publicly reply to reviewer', actionType: 'send_review_reply', riskTier: 'high', needsApproval: true },
          ],
          objectId: ctx.object.id,
          severity: 'high',
        });
      }
    }

    if (ctx.object.type === 'Lead') {
      const responded = typeof p.lastFollowUpAt === 'string' && p.lastFollowUpAt.length > 0;
      const ageMin = minutesSince(p.createdAt ?? p.at, ctx.now);
      if (!responded && ageMin !== null && ageMin > cfg.leadUnworkedMin) {
        out.push({
          domain: this.domain,
          sourceAgent: this.domain,
          title: `Lead ${label(ctx)}: unworked ${Math.round(ageMin / 60)}h`,
          why: 'Lead has had no follow-up past the working threshold; conversion decays with delay.',
          evidence: [{ kind: 'lead', ref: ctx.object.id, note: `no follow-up, age ${Math.round(ageMin / 60)}h` }],
          confidence: 0.7,
          proposedActions: [{ label: 'Assign owner', actionType: 'assign', riskTier: 'low', needsApproval: true }],
          objectId: ctx.object.id,
          severity: 'medium',
        });
      }
    }
    return out;
  }
}

/**
 * Equipment: calibration validity gates result trust. Overdue calibration risks every result the
 * device produces; using it while overdue is a hard conflict a manager must see. Uses the S0-7
 * calibrationValidDays (per-device override via properties.calibrationValidDays).
 */
export class EquipmentAgent implements DomainAgent {
  readonly domain: DomainName = 'equipment';
  propose(ctx: AgentContext): RecommendationCandidate[] {
    if (ctx.object.type !== 'Equipment') return [];
    const p = ctx.object.properties;
    const validDays = numProp(p, 'calibrationValidDays') ?? DOMAIN_THRESHOLDS.equipment.calibrationValidDays;
    const ageMin = minutesSince(p.lastCalibratedAt, ctx.now);
    const overdue = ageMin !== null && ageMin / 1440 > validDays;
    if (!overdue) return [];
    const days = Math.round((ageMin as number) / 1440);

    // Used-while-overdue is the stronger, conflict-flavored cue; it supersedes the plain overdue nudge.
    if (ctx.related?.usageScan) {
      return [
        {
          domain: this.domain,
          sourceAgent: this.domain,
          title: `${label(ctx)} used while calibration overdue — flag result validity`,
          why: `Device was scanned in use ${days}d past its ${validDays}d calibration window; results may be invalid.`,
          evidence: [{ kind: 'equipment', ref: ctx.object.id, note: `calibrated ${days}d ago; used via QR scan` }],
          confidence: 0.9,
          proposedActions: [{ label: 'Set device offline · create calibration task', actionType: 'equipment_offline', riskTier: 'low', needsApproval: true }],
          objectId: ctx.object.id,
          severity: 'high',
          impact: 2,
          resourceKey: `equipment:${ctx.object.id}`,
        },
      ];
    }
    return [
      {
        domain: this.domain,
        sourceAgent: this.domain,
        title: `${label(ctx)} calibration overdue — result validity at risk`,
        why: `Last calibrated ${days}d ago (valid ${validDays}d). Block or route to backup before the next booking.`,
        evidence: [{ kind: 'equipment', ref: ctx.object.id, note: `calibrated ${days}d ago (valid ${validDays}d)` }],
        confidence: 0.85,
        proposedActions: [{ label: 'Block device · route to backup', actionType: 'block_device', riskTier: 'low', needsApproval: true }],
        objectId: ctx.object.id,
        severity: 'high',
        resourceKey: `equipment:${ctx.object.id}`,
      },
    ];
  }
}

export const DEFAULT_AGENTS: DomainAgent[] = [
  new PatientFlowAgent(),
  new StaffAgent(),
  new InventoryAgent(),
  new FinancialAgent(),
  new MarketingAgent(),
  new EquipmentAgent(),
];
