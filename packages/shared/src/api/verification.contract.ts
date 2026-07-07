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

/** Per-task-type SOP config (frozen in S0-7; sensible defaults until then). */
export interface TaskSopConfig {
  taskType: string;
  expectedState: string;
  expectedDurationMin?: number;
  requiredEvidence: string[];
  confidenceThreshold: number;
}
