import type { EvidenceItem, TriggerReason, VerificationResult, VerifiedState } from '@clearview/shared';

/**
 * Input to a Scorer: the resolved claim + normalized evidence + flags. The gatherer builds
 * this from the ontology; the scorer is a pure, deterministic function of it.
 */
export interface ScoreInput {
  claimPresent: boolean;
  claimMatchesExpected: boolean;
  evidence: EvidenceItem[];
  requiredMissing: string[];
  timingAnomaly: boolean;
  crossObjectContradiction: boolean;
  threshold: number;
  /**
   * S0-7: per-evidence-kind multiplier from the task's TaskSopConfig. Each supporting item's
   * strength is scaled by weights[item.type] (default 1.0 = neutral, pre-S0-7 behavior)
   * before it is folded into confidence. Contradictions are NOT down-weighted — a conflict
   * signal must never be softened by a task-specific weight.
   */
  weights?: Record<string, number>;
  /**
   * S0-7: base confidence for a lone matching self-claim, from TaskSopConfig.baseSelfClaim.
   * Defaults to BASE_SELF_CLAIM. This is the base-0.50-vs-0.76 lever (see sop-config.ts).
   */
  baseSelfClaim?: number;
}

/** Pluggable scoring seam — an LLM scorer can implement this later for free-text/voice nuance. */
export interface Scorer {
  score(input: ScoreInput): VerificationResult;
}

/** DI token for the active Scorer (swap DeterministicScorer → an LLM scorer later). */
export const SCORER = 'SCORER';

/** Confidence in a lone, credible self-claim before independent evidence (calibrated to §4). */
export const BASE_SELF_CLAIM = 0.76;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Deterministic, explainable scorer.
 * confidence starts at BASE_SELF_CLAIM for a matching claim, then each INDEPENDENT supporting
 * item raises it toward 1 with diminishing returns: c ← c + (1−c)·strength.
 *
 * State machine — precedence (founder-frozen; §4 Room-3 must survive it):
 *   1. no claim                                    ⇒ unverified
 *   2. explicit contradiction (contradicting/cross-object)                 ⇒ conflict
 *   3. timing anomaly WHILE the REQUIRED evidence is not yet satisfied      ⇒ conflict
 *      (a suspiciously fast claim you cannot yet prove — this OVERRIDES the
 *       required-missing→pending cap; a strong but non-required signal such as
 *       a QR scan does NOT clear it — only the actual required evidence does)
 *   4. required evidence missing, no anomaly        ⇒ pending (missing_required)
 *   5. confidence ≥ threshold (required satisfied, no conflict) ⇒ verified
 *   6. otherwise                                    ⇒ pending (low_confidence)
 *
 * §4 Room-3: claim-only + too-fast + snapshot missing ⇒ conflict (rule 3). Once the required
 * snapshot is attached, the requirement is satisfied → the timing anomaly is treated as resolved
 * (rule 3 no longer applies) → verified (rule 5). Same input ⇒ same output.
 */
export class DeterministicScorer implements Scorer {
  score(input: ScoreInput): VerificationResult {
    const supporting = input.evidence.filter((e) => e.supports);
    const contradicting = input.evidence.filter((e) => !e.supports);

    // S0-7: per-task base and per-kind weights. Defaults keep the founder-frozen §4 arithmetic.
    const base = input.baseSelfClaim ?? BASE_SELF_CLAIM;
    const weightFor = (type: string): number => {
      const w = input.weights?.[type];
      return typeof w === 'number' && Number.isFinite(w) ? clamp01(w) : 1;
    };

    let confidence = input.claimPresent && input.claimMatchesExpected ? clamp01(base) : 0;
    for (const e of supporting) {
      const effective = clamp01(e.strength * weightFor(e.type));
      confidence = confidence + (1 - confidence) * effective;
    }
    confidence = clamp01(confidence);

    const requiredSatisfied = input.requiredMissing.length === 0;
    const explicitContradiction = contradicting.length > 0 || input.crossObjectContradiction;
    // A timing anomaly is a hard conflict ONLY while the required evidence is still missing;
    // satisfying the requirement resolves it (that is the §4 conflict→verified transition).
    const conflict = explicitContradiction || (input.timingAnomaly && !requiredSatisfied);

    const triggered: TriggerReason[] = [];
    let verifiedState: VerifiedState;
    if (!input.claimPresent) {
      verifiedState = 'unverified';
    } else if (conflict) {
      verifiedState = 'conflict';
      triggered.push('conflict');
      if (!requiredSatisfied) triggered.push('missing_required');
    } else if (!requiredSatisfied) {
      verifiedState = 'pending';
      triggered.push('missing_required');
    } else if (confidence >= input.threshold) {
      verifiedState = 'verified';
    } else {
      verifiedState = 'pending';
      triggered.push('low_confidence');
    }

    return {
      verifiedState,
      confidence: round3(confidence),
      reason: this.buildReason(verifiedState, confidence, supporting, contradicting, input),
      evidence: input.evidence,
      requiredMissing: input.requiredMissing,
      triggered,
    };
  }

  private buildReason(
    state: VerifiedState,
    confidence: number,
    supporting: EvidenceItem[],
    contradicting: EvidenceItem[],
    input: ScoreInput,
  ): string {
    const parts: string[] = [`state=${state} confidence=${confidence.toFixed(2)}`];
    if (supporting.length) {
      parts.push(`support: ${supporting.map((e) => `${e.type}(+${e.strength.toFixed(2)})`).join(', ')}`);
    }
    if (input.requiredMissing.length) parts.push(`missing required: ${input.requiredMissing.join(', ')}`);
    if (input.timingAnomaly) parts.push('timing anomaly vs SOP');
    if (contradicting.length) parts.push(`contradicting: ${contradicting.map((e) => e.type).join(', ')}`);
    if (input.crossObjectContradiction) parts.push('cross-object contradiction');
    return parts.join('; ');
  }
}
