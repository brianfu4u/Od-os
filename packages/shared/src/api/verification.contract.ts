import type { VerifiedState } from '../ontology/objects';

/**
 * S2 cross-verification contract. A deterministic, explainable scorer reconciles a claim
 * against independent evidence → a VerificationResult (verified_state + confidence + reason
 * + evidence breakdown), appended immutably to the verification ledger. LLM scoring is a
 * later pluggable seam behind the same Scorer interface.
 */
export type EvidenceType = 'qr_scan' | 'snapshot' | 'document' | 'communication' | 'timing' | 'cross_object';

export type TriggerReason = 'conflict' | 'low_confidence' | 'missing_required' | 'overdue';

export interface EvidenceItem {
  type: EvidenceType;
  /** true = corroborates the claim; false = contradicts it. */
  supports: boolean;
  /** [0,1] — weight × sourceTrust × recency, already normalized. */
  strength: number;
  detail: string;
  /** Source object id, when applicable. */
  ref?: string;
}

export interface VerificationResult {
  verifiedState: VerifiedState;
  confidence: number;
  /** Human-readable explanation built from the evidence breakdown. */
  reason: string;
  evidence: EvidenceItem[];
  /** Required-evidence kinds that were absent (caps the state at pending). */
  requiredMissing: string[];
  /** Trigger reasons that should raise Alerts. */
  triggered: TriggerReason[];
}

/**
 * Per-task-type SOP config (frozen with the clinic in S0-7).
 *
 * S0-7 adds two calibration knobs so the freeze can be tuned per task type without an
 * engine change:
 *  - `evidenceWeights`: per-evidence-kind multiplier applied to each item's normalized
 *    strength before it is folded into confidence. 1.0 = neutral (pre-S0-7 behavior).
 *    Lets a task type say "a snapshot is worth more than a document" for THIS task.
 *  - `baseSelfClaim`: the confidence a lone, matching self-claim carries BEFORE any
 *    independent evidence. Defaults to the calibrated global (DEFAULT_BASE_SELF_CLAIM).
 *    See sop-config.ts for the base-0.50-vs-0.76 decision that this field exposes.
 */
export interface TaskSopConfig {
  taskType: string;
  expectedState: string;
  expectedDurationMin?: number;
  requiredEvidence: string[];
  confidenceThreshold: number;
  /** Per-evidence-kind strength multiplier (default 1.0 per kind). */
  evidenceWeights?: Record<string, number>;
  /** Base confidence for a lone matching self-claim (default DEFAULT_BASE_SELF_CLAIM). */
  baseSelfClaim?: number;
}
