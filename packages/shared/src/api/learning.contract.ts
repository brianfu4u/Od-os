/**
 * P4 · S8 learning-loop contract. Deterministic, explainable, human-in-the-loop: feedback is
 * captured append-only; a `learn` run produces BOUNDED parameter adjustments with an auditable
 * basis; S2 (scorer) and S3 (orchestrator) read the tuned params back. Nothing here re-ranks with
 * an LLM or acts on the world — it only tunes numbers, reversibly.
 */

export type LearningFeedbackKind =
  | 'recommendation_approved'
  | 'recommendation_dismissed'
  | 'recommendation_snoozed'
  | 'recommendation_undone'
  | 'verdict_correction';

/** A captured feedback signal (wire shape of a learning_feedback row). */
export interface LearningFeedbackRecord {
  id: string;
  kind: LearningFeedbackKind;
  domain?: string | null;
  actionType?: string | null;
  taskType?: string | null;
  objectId?: string | null;
  recommendationId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  evidenceKinds?: string[];
  at: string;
}

/** Per-tenant learned task params S2 reads back (merged over the S0-7 defaults). */
export interface LearnedTaskParams {
  weights?: Record<string, number>;
  threshold?: number;
  base?: number;
}

/** One bounded change a learn run made (mirrored into learning_audit). */
export interface LearningChange {
  paramType: 'task' | 'domain_priority';
  paramKey: string;
  field: string; // e.g. 'weights.snapshot', 'threshold', 'penalty'
  before: number | null;
  after: number;
  basis: { sampleSize: number; signal: string; detail?: string };
}

/** Result of a learn run (also the /learning/run response). */
export interface LearningRunResult {
  runId: string;
  feedbackConsidered: number;
  changes: LearningChange[];
}

/** A learning_audit row (wire shape). */
export interface LearningAuditRecord {
  id: string;
  runId: string;
  paramType: string;
  paramKey: string;
  field: string;
  before: unknown;
  after: unknown;
  basis: Record<string, unknown>;
  kind: 'adjust' | 'rollback' | 'noop';
  at: string;
}
