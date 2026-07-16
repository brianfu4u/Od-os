import { describe, it, expect } from 'vitest';
import { DeterministicScorer, BASE_SELF_CLAIM, type ScoreInput } from './scorer';
import { COIN_FLIP_BASE_SELF_CLAIM } from './sop-config';

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
  it('claim-only + missing required snapshot + timing anomaly → conflict @ 0.50', () => {
    const r = scorer.score({ ...base, requiredMissing: ['snapshot'], timingAnomaly: true });
    expect(r.verifiedState).toBe('conflict');
    expect(r.verificationScore).toBeCloseTo(0.5, 2);
    expect(r.triggered).toContain('conflict');
  });

  it('after the snapshot is attached → verified @ 0.855', () => {
    const r = scorer.score({
      ...base,
      // required snapshot now SATISFIED (requiredMissing empty) → the timing anomaly is
      // considered resolved (rule 3 no longer applies) → verified.
      evidence: [{ type: 'snapshot', supports: true, strength: 0.71, detail: 'turnover photo' }],
      requiredMissing: [],
      timingAnomaly: true,
    });
    expect(r.verifiedState).toBe('verified');
    expect(r.verificationScore).toBeCloseTo(0.855, 3);
    expect(r.triggered).toHaveLength(0);
  });

  it('a strong but NON-required signal (QR scan) does not clear a missing-snapshot timing conflict', () => {
    // The smoke scenario: fast claim + a QR scan, but the required snapshot is still missing.
    // The QR raises the verification score yet does not satisfy the requirement → still a conflict, NOT pending.
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'qr_scan', supports: true, strength: 0.85, detail: 'scan referencing task' }],
      requiredMissing: ['snapshot'],
      timingAnomaly: true,
    });
    expect(r.verifiedState).toBe('conflict');
    expect(r.triggered).toContain('conflict');
    expect(r.triggered).toContain('missing_required');
  });

  it('timing anomaly with the requirement satisfied is NOT a conflict (anomaly resolved)', () => {
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'snapshot', supports: true, strength: 0.71, detail: 'photo' }],
      requiredMissing: [],
      timingAnomaly: true,
    });
    expect(r.verifiedState).toBe('verified');
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

describe('DeterministicScorer — S0-7 per-task evidenceWeights + baseSelfClaim', () => {
  it('default (no weights) reproduces the frozen §4 arithmetic: claim + snapshot(0.71) → 0.855', () => {
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'snapshot', supports: true, strength: 0.71, detail: 'photo' }],
    });
    // base 0.50 (frozen): 0.50 + (1-0.50)*0.71 = 0.855
    expect(r.verificationScore).toBeCloseTo(0.855, 3);
    expect(BASE_SELF_CLAIM).toBe(0.5);
  });

  it('a per-task weight < 1 down-weights that evidence kind (0.5 halves the snapshot signal)', () => {
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'snapshot', supports: true, strength: 0.71, detail: 'photo' }],
      weights: { snapshot: 0.5 },
    });
    // effective = 0.71*0.5 = 0.355 → 0.50 + (1-0.50)*0.355 = 0.6775 → 0.678
    expect(r.verificationScore).toBeCloseTo(0.678, 3);
  });

  it('weight 1.0 is neutral (identical to omitting weights)', () => {
    const withW = scorer.score({
      ...base,
      evidence: [{ type: 'qr_scan', supports: true, strength: 0.85, detail: 'scan' }],
      weights: { qr_scan: 1.0 },
    });
    const without = scorer.score({
      ...base,
      evidence: [{ type: 'qr_scan', supports: true, strength: 0.85, detail: 'scan' }],
    });
    expect(withW.verificationScore).toBe(without.verificationScore);
  });

  it('a single required snapshot verifies from the coin-flip base: 0.50 → 0.855 ≥ 0.85', () => {
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'snapshot', supports: true, strength: 0.71, detail: 'photo' }],
      baseSelfClaim: COIN_FLIP_BASE_SELF_CLAIM,
    });
    // 0.50 + (1-0.50)*0.71 = 0.855
    expect(r.verificationScore).toBeCloseTo(0.855, 3);
    expect(r.verifiedState).toBe('verified');
  });

  it('a bare claim is a true coin-flip (0.50, below threshold → pending low_confidence)', () => {
    const r = scorer.score({ ...base, baseSelfClaim: COIN_FLIP_BASE_SELF_CLAIM });
    expect(r.verificationScore).toBeCloseTo(0.5, 3);
    expect(r.verifiedState).toBe('pending');
    expect(r.triggered).toContain('low_confidence');
  });

  it('per-task weight never softens a contradiction (conflict precedence survives weighting)', () => {
    const r = scorer.score({
      ...base,
      evidence: [{ type: 'cross_object', supports: false, strength: 0.6, detail: 'room still occupied' }],
      weights: { cross_object: 0 },
    });
    expect(r.verifiedState).toBe('conflict');
  });
});
