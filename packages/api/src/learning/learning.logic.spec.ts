import { describe, it, expect } from 'vitest';
import { computeAdjustments, type CurrentResolvers, type LearnFeedback } from './learning.logic';
import { LEARNING } from './learning-config';

/** Current resolvers that start every param at its neutral default (1.0 weight / 0.85 thr / 0 penalty). */
function resolvers(over: Partial<CurrentResolvers> = {}): CurrentResolvers {
  return {
    weight: () => 1.0,
    threshold: () => 0.85,
    penalty: () => 0,
    ...over,
  };
}
const dismiss = (domain: string, n: number): LearnFeedback[] =>
  Array.from({ length: n }, () => ({ kind: 'recommendation_dismissed' as const, domain }));
const correction = (taskType: string, toState: string, evidenceKinds: string[], n: number): LearnFeedback[] =>
  Array.from({ length: n }, () => ({ kind: 'verdict_correction' as const, taskType, toState, evidenceKinds }));

describe('learning logic — bounded, deterministic, low-sample-safe', () => {
  it('downgrades a domain whose cues are repeatedly ignored (bounded by step)', () => {
    const changes = computeAdjustments(dismiss('marketing', 5), resolvers());
    const c = changes.find((x) => x.paramType === 'domain_priority' && x.paramKey === 'marketing');
    expect(c).toBeTruthy();
    expect(c!.field).toBe('penalty');
    expect(c!.before).toBe(0);
    expect(c!.after).toBe(LEARNING.penalty.step); // one bounded step up (0 → 0.5)
    expect(c!.after).toBeLessThanOrEqual(LEARNING.penalty.max);
  });

  it('does NOT adjust on low sample (below minSample)', () => {
    expect(computeAdjustments(dismiss('marketing', LEARNING.minSample - 1), resolvers())).toHaveLength(0);
  });

  it('raises an evidence weight that repeatedly correlates with real completion (not beyond max)', () => {
    const changes = computeAdjustments(correction('room_turnover', 'verified', ['snapshot'], 5), resolvers());
    const w = changes.find((x) => x.field === 'weights.snapshot' && x.paramKey === 'room_turnover');
    expect(w).toBeTruthy();
    expect(w!.after).toBeCloseTo(1.0 + LEARNING.weight.step, 5); // 1.0 → 1.1
    expect(w!.after).toBeLessThanOrEqual(LEARNING.weight.max);
  });

  it('lowers an evidence weight that correlates with non-completion', () => {
    const changes = computeAdjustments(correction('pretest_done', 'conflict', ['communication'], 4), resolvers({ weight: () => 0.6 }));
    const w = changes.find((x) => x.field === 'weights.communication');
    expect(w!.after).toBeCloseTo(0.5, 5); // 0.6 → 0.5
  });

  it('never pushes a weight past the max (no change when already at the ceiling)', () => {
    const changes = computeAdjustments(correction('room_turnover', 'verified', ['snapshot'], 6), resolvers({ weight: () => LEARNING.weight.max }));
    expect(changes.find((x) => x.field === 'weights.snapshot')).toBeUndefined();
  });

  it('adjusts the threshold from verdict-correction direction (bounded)', () => {
    // corrections that flip prior verifieds to conflict → raise the bar.
    const changes = computeAdjustments(correction('room_turnover', 'conflict', [], 4), resolvers());
    const t = changes.find((x) => x.field === 'threshold');
    expect(t!.after).toBeCloseTo(0.85 + LEARNING.threshold.step, 5);
    expect(t!.after).toBeLessThanOrEqual(LEARNING.threshold.max);
  });

  it('is deterministic — same input yields identical output', () => {
    const fb = [...dismiss('marketing', 5), ...correction('room_turnover', 'verified', ['snapshot'], 5)];
    expect(computeAdjustments(fb, resolvers())).toEqual(computeAdjustments(fb, resolvers()));
  });
});
