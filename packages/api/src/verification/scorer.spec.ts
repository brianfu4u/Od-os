import { describe, it, expect } from 'vitest';
import { DeterministicScorer, type ScoreInput } from './scorer';

const scorer = new DeterministicScorer();
const base: ScoreInput = {
  claimPresent: true,
  claimMatchesExpected: true,
  evidence: [],
  requiredMissing: [],
  timingAnomaly: false,
  crossObjectContradiction: false,
  threshold: 0.85,
};

describe('DeterministicScorer — Room 3 (§4)', () => {
  it('claim-only + missing required snapshot + timing anomaly → conflict @ 0.76', () => {
    const r = scorer.score({ ...base, requiredMissing: ['snapshot'], timingAnomaly: true });
    expect(r.verifiedState).toBe('conflict');
    expect(r.confidence).toBeCloseTo(0.76, 2);
    expect(r.triggered).toContain('conflict');
  });

  it('after the snapshot is attached → verified @ 0.93', () => {
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'snapshot', supports: true, strength: 0.71, detail: 'turnover photo' }],
      timingAnomaly: true, // still flagged, but strong evidence overrides → not a conflict
    });
    expect(r.verifiedState).toBe('verified');
    expect(r.confidence).toBeCloseTo(0.93, 2);
    expect(r.triggered).toHaveLength(0);
  });
});

describe('DeterministicScorer — rules', () => {
  it('required missing (no contradiction) → pending', () => {
    const r = scorer.score({ ...base, requiredMissing: ['document'] });
    expect(r.verifiedState).toBe('pending');
    expect(r.triggered).toContain('missing_required');
  });
  it('no claim → unverified', () => {
    const r = scorer.score({ ...base, claimPresent: false, claimMatchesExpected: false });
    expect(r.verifiedState).toBe('unverified');
  });
  it('explicit contradicting evidence → conflict', () => {
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'cross_object', supports: false, strength: 0.6, detail: 'room still occupied' }],
    });
    expect(r.verifiedState).toBe('conflict');
  });
  it('is deterministic (same input → same output)', () => {
    const input = { ...base, evidence: [{ type: 'qr_scan' as const, supports: true, strength: 0.85, detail: 'scan' }] };
    expect(scorer.score(input)).toEqual(scorer.score(input));
  });
});
