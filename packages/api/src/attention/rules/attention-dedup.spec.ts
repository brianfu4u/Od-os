import { describe, it, expect } from 'vitest';
import type { AttentionCandidate } from '@clearview/shared';
import { dedupForDisplay } from './attention-dedup';

function cand(over: Partial<AttentionCandidate> = {}): AttentionCandidate {
  return {
    employeeId: 'e1',
    employeeName: 'Tech A',
    kind: 'silence',
    evidenceSummary: { who: 'Tech A', when: null, claimed: 'on_duty', submitted: null, systemObserved: 'x' },
    lastEventAt: null,
    generatedAt: '2026-07-15T12:00:00.000Z',
    ...over,
  };
}

describe('dedupForDisplay', () => {
  it('collapses same employee + same kind into one item with a stable id', () => {
    const items = dedupForDisplay([cand(), cand({ generatedAt: '2026-07-15T12:05:00.000Z' })]);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('e1:silence');
  });

  it('keeps the freshest candidate when collapsing', () => {
    const items = dedupForDisplay([
      cand({ generatedAt: '2026-07-15T12:00:00.000Z', evidenceSummary: { who: 'Tech A', when: null, claimed: 'on_duty', submitted: null, systemObserved: 'old' } }),
      cand({ generatedAt: '2026-07-15T12:09:00.000Z', evidenceSummary: { who: 'Tech A', when: null, claimed: 'on_duty', submitted: null, systemObserved: 'new' } }),
    ]);
    expect(items[0]!.evidenceSummary.systemObserved).toBe('new');
  });

  it('keeps different kinds for the same employee as separate items', () => {
    const items = dedupForDisplay([cand({ kind: 'silence' }), cand({ kind: 'low_confidence' })]);
    expect(items.map((i) => i.id).sort()).toEqual(['e1:low_confidence', 'e1:silence']);
  });

  it('keeps same kind for different employees separate, and sorts by name then kind', () => {
    const items = dedupForDisplay([
      cand({ employeeId: 'e2', employeeName: 'Zed', kind: 'silence' }),
      cand({ employeeId: 'e1', employeeName: 'Ann', kind: 'silence' }),
      cand({ employeeId: 'e1', employeeName: 'Ann', kind: 'low_confidence' }),
    ]);
    expect(items.map((i) => `${i.employeeName}:${i.kind}`)).toEqual([
      'Ann:low_confidence',
      'Ann:silence',
      'Zed:silence',
    ]);
  });

  it('returns an empty list for no candidates', () => {
    expect(dedupForDisplay([])).toEqual([]);
  });
});
