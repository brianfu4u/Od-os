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
 * item raises it toward 1 with diminishing returns: c ← c + (1−c)·strength. State is decided by
 * hard rules: a contradiction (contradicting evidence, cross-object conflict, or a timing anomaly
 * unbacked by strong evidence) ⇒ conflict; required evidence missing ⇒ at most pending; else
 * confidence ≥ threshold ⇒ verified. Same input ⇒ same output.
 */
export class DeterministicScorer implements Scorer {
  score(input: ScoreInput): VerificationResult {
    const supporting = input.evidence.filter((e) => e.supports);
    const contradicting = input.evidence.filter((e) => !e.supports);

    let confidence = input.claimPresent && input.claimMatchesExpected ? BASE_SELF_CLAIM : 0;
    for (const e of supporting) confidence = confidence + (1 - confidence) * clamp01(e.strength);
    confidence = clamp01(confidence);

    const strongSupport = supporting.some((e) => e.strength >= 0.5);
    const hasContradiction =
      contradicting.length > 0 || input.crossObjectContradiction || (input.timingAnomaly && !strongSupport);

    const triggered: TriggerReason[] = [];
    let verifiedState: VerifiedState;
    if (!input.claimPresent) {
      verifiedState = 'unverified';
    } else if (hasContradiction) {
      verifiedState = 'conflict';
      triggered.push('conflict');
    } else if (input.requiredMissing.length > 0) {
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
