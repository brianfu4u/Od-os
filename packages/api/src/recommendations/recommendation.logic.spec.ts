import { describe, it, expect } from 'vitest';
import {
  PatientFlowAgent,
  StaffAgent,
  InventoryAgent,
  FinancialAgent,
  MarketingAgent,
  EquipmentAgent,
  type AgentContext,
} from './agents';
import { Orchestrator } from './orchestrator';
import type { RecommendationCandidate } from '@clearview/shared';

function ctx(over: Partial<AgentContext['object']>, alert?: AgentContext['alert']): AgentContext {
  return {
    object: { id: 'o1', type: 'Task', properties: {}, verifiedState: null, claimedState: null, confidence: null, ...over },
    alert: alert ?? null,
    now: Date.now(),
  };
}

describe('domain agents', () => {
  it('patient-flow fires on a conflicted turnover task', () => {
    const out = new PatientFlowAgent().propose(
      ctx({ properties: { taskType: 'room_turnover', label: 'Room 3' }, verifiedState: 'conflict', confidence: 0.5 }, {
        id: 'a1',
        triggered: ['conflict'],
        severity: 'high',
        reason: 'missing snapshot; timing anomaly',
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('patient_flow');
    expect(out[0]!.addresses).toBe('a1');
    expect(out[0]!.evidence[0]!.kind).toBe('verification');
  });

  it('patient-flow stays silent on a non-flow object', () => {
    expect(new PatientFlowAgent().propose(ctx({ type: 'InventoryItem' }))).toHaveLength(0);
  });

  it('staff fires only when overdue', () => {
    expect(new StaffAgent().propose(ctx({ verifiedState: 'pending' }, { id: 'a', triggered: ['overdue'], severity: 'medium', reason: 'overdue' }))).toHaveLength(1);
    expect(new StaffAgent().propose(ctx({}, { id: 'a', triggered: ['conflict'], severity: 'high', reason: 'x' }))).toHaveLength(0);
  });

  it('inventory fires when on-hand ≤ reorder point', () => {
    expect(new InventoryAgent().propose(ctx({ type: 'InventoryItem', properties: { onHand: 2, reorderPoint: 5, name: 'solution' } }))).toHaveLength(1);
    expect(new InventoryAgent().propose(ctx({ type: 'InventoryItem', properties: { onHand: 9, reorderPoint: 5 } }))).toHaveLength(0);
  });
});

describe('domain agents — financial / marketing / equipment (S3+)', () => {
  const now = Date.parse('2026-07-08T12:00:00Z');
  const ago = (min: number): string => new Date(now - min * 60_000).toISOString();
  const days = (d: number): string => new Date(now - d * 86_400_000).toISOString();
  function mk(
    type: string,
    properties: Record<string, unknown>,
    extra: { object?: Partial<AgentContext['object']>; related?: AgentContext['related'] } = {},
  ): AgentContext {
    return {
      object: { id: 'x', type, properties, verifiedState: null, claimedState: null, confidence: null, ...(extra.object ?? {}) },
      alert: null,
      related: extra.related,
      now,
    };
  }

  it('financial flags a collected-but-unposted invoice, ignores a posted one', () => {
    expect(
      new FinancialAgent().propose(mk('Invoice', { label: 'INV-1', amountCents: 1000 }, { object: { claimedState: 'collected' } })),
    ).toHaveLength(1);
    expect(
      new FinancialAgent().propose(mk('Invoice', {}, { object: { claimedState: 'collected', verifiedState: 'posted' } })),
    ).toHaveLength(0);
  });

  it('financial flags a claim missing a required field (high severity), ignores a complete claim', () => {
    const out = new FinancialAgent().propose(mk('Claim', { label: 'C-1', missingFields: ['referral'] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.domain).toBe('financial');
    expect(out[0]!.title).toContain('referral');
    expect(out[0]!.severity).toBe('high');
    expect(new FinancialAgent().propose(mk('Claim', { missingFields: [] }))).toHaveLength(0);
  });

  it('marketing fires on a 2★ review past SLA; quiet if fresh, positive, or answered', () => {
    expect(new MarketingAgent().propose(mk('Review', { rating: 2, at: ago(72) }))).toHaveLength(1);
    expect(new MarketingAgent().propose(mk('Review', { rating: 2, at: ago(10) }))).toHaveLength(0); // within 60m SLA
    expect(new MarketingAgent().propose(mk('Review', { rating: 5, at: ago(999) }))).toHaveLength(0); // positive
    expect(new MarketingAgent().propose(mk('Review', { rating: 1, at: ago(999), respondedAt: ago(5) }))).toHaveLength(0);
  });

  it('marketing flags an unworked aging lead (> 24h), quiet if recently followed up', () => {
    expect(new MarketingAgent().propose(mk('Lead', { createdAt: ago(30 * 60) }))).toHaveLength(1);
    expect(new MarketingAgent().propose(mk('Lead', { createdAt: ago(30 * 60), lastFollowUpAt: ago(10) }))).toHaveLength(0);
  });

  it('equipment flags calibration overdue; quiet when current; per-object validDays override wins', () => {
    const out = new EquipmentAgent().propose(mk('Equipment', { label: 'OCT #2', lastCalibratedAt: days(31), calibrationValidDays: 30 }));
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain('calibration overdue');
    expect(new EquipmentAgent().propose(mk('Equipment', { lastCalibratedAt: days(5), calibrationValidDays: 30 }))).toHaveLength(0);
    // per-object override: a 90-day window means 31 days is NOT overdue (threshold from config/props).
    expect(new EquipmentAgent().propose(mk('Equipment', { lastCalibratedAt: days(31), calibrationValidDays: 90 }))).toHaveLength(0);
  });

  it('equipment escalates to a used-while-overdue conflict when a usage scan is present', () => {
    const out = new EquipmentAgent().propose(
      mk('Equipment', { label: 'OCT #2', lastCalibratedAt: days(31), calibrationValidDays: 30 }, { related: { usageScan: true } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toContain('used while calibration overdue');
    expect(out[0]!.severity).toBe('high');
    expect(out[0]!.impact).toBe(2);
  });
});

describe('orchestrator', () => {
  const base: RecommendationCandidate = {
    domain: 'patient_flow',
    sourceAgent: 'patient_flow',
    title: 't',
    why: 'w',
    evidence: [],
    confidence: 0.5,
    proposedActions: [],
    objectId: 'o',
    severity: 'low',
  };

  it('ranks by severity × impact, desc', () => {
    const ranked = new Orchestrator().orchestrate([
      { ...base, title: 'low', severity: 'low' },
      { ...base, title: 'high', severity: 'high', impact: 2 },
      { ...base, title: 'med', severity: 'medium' },
    ]);
    expect(ranked.map((r) => r.title)).toEqual(['high', 'med', 'low']);
    expect(ranked[0]!.rank).toBe(1);
  });

  it('de-conflicts a shared resource and annotates the trade-off', () => {
    const ranked = new Orchestrator().orchestrate([
      { ...base, domain: 'staff', sourceAgent: 'staff', title: 'pull Jordan to pretest', severity: 'high', resourceKey: 'staff:jordan' },
      { ...base, domain: 'patient_flow', sourceAgent: 'patient_flow', title: 'keep Jordan on optical', severity: 'medium', resourceKey: 'staff:jordan' },
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.title).toBe('pull Jordan to pretest');
    expect(ranked[0]!.tradeoff).toContain('keep Jordan on optical');
  });

  it('caps the active feed', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...base, title: `c${i}` }));
    expect(new Orchestrator().orchestrate(many, 5)).toHaveLength(5);
  });
});
