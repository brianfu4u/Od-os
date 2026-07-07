import { describe, it, expect } from 'vitest';
import { PatientFlowAgent, StaffAgent, InventoryAgent, type AgentContext } from './agents';
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
      ctx({ properties: { taskType: 'room_turnover', label: 'Room 3' }, verifiedState: 'conflict', confidence: 0.76 }, {
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
