import { describe, it, expect } from 'vitest';
import {
  ruleSilence,
  ruleStatusInconsistency,
  ruleScanNoFollowup,
  ruleLowConfidence,
  runAllRules,
  type EmployeeFactsSnapshot,
} from './attention-rules';
import { ATTENTION_DEFAULTS } from '../attention.config';

const CFG = ATTENTION_DEFAULTS;
const NOW = '2026-07-15T12:00:00.000Z';

function facts(over: Partial<EmployeeFactsSnapshot> = {}): EmployeeFactsSnapshot {
  return {
    employeeId: 'e1',
    employeeName: 'Tech A',
    claimedStatus: null,
    lastEventAt: NOW,
    secondsSinceLastEvent: 0,
    lastScanAt: null,
    lastScanCode: null,
    secondsSinceLastScan: null,
    secondsSinceScanFollowup: null,
    verificationResult: null,
    verificationConfidence: null,
    nowIso: NOW,
    ...over,
  };
}

describe('ruleSilence', () => {
  it('fires when on_duty and stale past the threshold', () => {
    const c = ruleSilence(facts({ claimedStatus: 'on_duty', secondsSinceLastEvent: 3700 }), CFG);
    expect(c?.kind).toBe('silence');
    expect(c?.evidenceSummary.claimed).toBe('on_duty');
  });
  it('fires when on_duty and never had a valid event (null)', () => {
    expect(ruleSilence(facts({ claimedStatus: 'on_duty', secondsSinceLastEvent: null }), CFG)?.kind).toBe('silence');
  });
  it('does NOT fire when fresh, or when not on_duty', () => {
    expect(ruleSilence(facts({ claimedStatus: 'on_duty', secondsSinceLastEvent: 60 }), CFG)).toBeNull();
    expect(ruleSilence(facts({ claimedStatus: 'busy', secondsSinceLastEvent: 99999 }), CFG)).toBeNull();
    expect(ruleSilence(facts({ claimedStatus: 'off_duty', secondsSinceLastEvent: 99999 }), CFG)).toBeNull();
  });
});

describe('ruleStatusInconsistency', () => {
  it('fires when busy but no activity within the busy window', () => {
    const c = ruleStatusInconsistency(facts({ claimedStatus: 'busy', secondsSinceLastEvent: 700 }), CFG);
    expect(c?.kind).toBe('status_inconsistency');
  });
  it('does NOT fire when busy with recent activity, or when not busy', () => {
    expect(ruleStatusInconsistency(facts({ claimedStatus: 'busy', secondsSinceLastEvent: 120 }), CFG)).toBeNull();
    expect(ruleStatusInconsistency(facts({ claimedStatus: 'on_duty', secondsSinceLastEvent: 99999 }), CFG)).toBeNull();
  });
});

describe('ruleScanNoFollowup', () => {
  it('fires when a scan happened but no progress within the window', () => {
    const c = ruleScanNoFollowup(
      facts({ lastScanAt: NOW, lastScanCode: 'PT-7', secondsSinceLastScan: 2000, secondsSinceScanFollowup: null }),
      CFG,
    );
    expect(c?.kind).toBe('scan_no_followup');
    expect(c?.evidenceSummary.submitted).toBe('PT-7');
  });
  it('does NOT fire without a scan, or when there was follow-up progress, or still within window', () => {
    expect(ruleScanNoFollowup(facts({ secondsSinceLastScan: null }), CFG)).toBeNull();
    expect(
      ruleScanNoFollowup(facts({ secondsSinceLastScan: 5000, secondsSinceScanFollowup: 10 }), CFG),
    ).toBeNull(); // progress happened
    expect(
      ruleScanNoFollowup(facts({ secondsSinceLastScan: 300, secondsSinceScanFollowup: null }), CFG),
    ).toBeNull(); // still within 1800s window
  });
});

describe('ruleLowConfidence', () => {
  it("fires on an 'inconsistent' verdict", () => {
    expect(ruleLowConfidence(facts({ verificationResult: 'inconsistent' }), CFG)?.kind).toBe('low_confidence');
  });
  it('fires when confidence is below the threshold', () => {
    expect(ruleLowConfidence(facts({ verificationConfidence: 0.4 }), CFG)?.kind).toBe('low_confidence');
  });
  it('does NOT fire when consistent and confidence at/above threshold, or when unchecked', () => {
    expect(ruleLowConfidence(facts({ verificationResult: 'consistent', verificationConfidence: 0.9 }), CFG)).toBeNull();
    expect(ruleLowConfidence(facts({ verificationConfidence: 0.6 }), CFG)).toBeNull(); // exactly at floor is fine
    expect(ruleLowConfidence(facts({}), CFG)).toBeNull(); // unchecked
  });
});

describe('runAllRules', () => {
  it('can fire multiple rules for one snapshot (silence + low_confidence)', () => {
    const out = runAllRules(
      facts({ claimedStatus: 'on_duty', secondsSinceLastEvent: 99999, verificationResult: 'inconsistent' }),
      CFG,
    );
    expect(out.map((c) => c.kind).sort()).toEqual(['low_confidence', 'silence']);
  });
  it('returns an empty array when nothing trips (only states facts, never invents them)', () => {
    expect(runAllRules(facts({ claimedStatus: 'idle', secondsSinceLastEvent: 10 }), CFG)).toEqual([]);
  });
  it('every candidate carries a neutral evidenceSummary — never a verdict/instruction to the employee', () => {
    const out = runAllRules(facts({ claimedStatus: 'on_duty', secondsSinceLastEvent: 99999 }), CFG);
    for (const c of out) {
      expect(c.evidenceSummary).toHaveProperty('who');
      expect(c.evidenceSummary).toHaveProperty('systemObserved');
      // no "action"/"instruction"/"verdict" fields leak into the summary
      expect(Object.keys(c.evidenceSummary).sort()).toEqual(
        ['claimed', 'submitted', 'systemObserved', 'when', 'who'],
      );
    }
  });
});
