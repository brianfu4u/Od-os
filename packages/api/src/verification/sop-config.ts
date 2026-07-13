import type { TaskSopConfig } from '@clearview/shared';
import { BASE_SELF_CLAIM } from './scorer';

const DEFAULT_THRESHOLD = 0.85;

/**
 * Resubmission (回退重提) attempt cap — the number of times a failing CLAIMED task is bounced
 * BACK TO THE STAFF before the ball moves to the MANAGER. `1` means: staff get exactly ONE
 * "add the missing evidence and resubmit" nudge; if the resubmission still fails, we stop nagging
 * the staff and ESCALATE to the manager instead (closed-loop step 6 terminal path). Defined ONCE
 * here so the whole loop (event emission in verify + the escalation agent + the read projection)
 * shares a single source of truth; raising it to N bounces is a one-line change.
 */
export const MAX_STAFF_RESUBMITS = 1;

/**
 * Base confidence for a lone, matching self-claim BEFORE any independent evidence.
 *
 * ── The base-0.50-vs-0.76 decision — RESOLVED at the S0-7 clinic freeze: 0.50 ──
 * The engine folds evidence in with diminishing returns: c ← c + (1−c)·strength, starting
 * from this base. So the base is literally "how much do we trust a bare 'I did it' claim
 * with zero independent proof?"
 *   • 0.76 (rejected): a bare claim already reads as "probably true" and sits one weak signal
 *     away from verified — too generous for an unproven self-report.
 *   • 0.50 (CHOSEN): a bare claim is a coin-flip prior — "unproven, equally likely either
 *     way" — the honest reading of self-report with no evidence. A single required snapshot
 *     (strength 0.71) still lands at 0.855 ≥ 0.85 → verified, so every founder-frozen §4
 *     Room-3 transition is preserved (conflict @0.50 → verified @0.855 once the snapshot is
 *     attached); but a lone claim can no longer masquerade as near-certain — it stays a
 *     coin-flip (0.50 → pending / low_confidence).
 *
 * Single source of truth: the effective base is the scorer's BASE_SELF_CLAIM; this constant
 * mirrors it so config and engine cannot drift. A task type may still override it per-task via
 * TaskSopConfig.baseSelfClaim.
 */
export const DEFAULT_BASE_SELF_CLAIM = BASE_SELF_CLAIM;

/** The coin-flip base an unevidenced claim carries — the chosen default (kept as the semantic name). */
export const COIN_FLIP_BASE_SELF_CLAIM = BASE_SELF_CLAIM;

/**
 * Default SOP config for the 5 MVP task types. FROZEN with the clinic in S0-7; these are
 * sensible defaults until then. Per-object overrides come from properties (requiredEvidence,
 * expectedDurationMin, evidenceWeights, baseSelfClaim), so freezing S0-7 config later needs
 * no engine change.
 *
 * evidenceWeights: per-task multipliers on each evidence kind's normalized strength. 1.0 is
 * neutral (identical to pre-S0-7 behavior). Tuned to each task's ground truth — e.g. a
 * room_turnover is best proven by the snapshot of the turned-over room, a dilation must be
 * proven by the QR scan at the chair, inventory/calibration lean on the document (PO / cert).
 */
export const DEFAULT_SOP: Record<string, TaskSopConfig> = {
  room_turnover: {
    taskType: 'room_turnover', expectedState: 'ready', expectedDurationMin: 6,
    requiredEvidence: ['snapshot'], confidenceThreshold: 0.85,
    evidenceWeights: { snapshot: 1.0, qr_scan: 0.9, document: 0.7, communication: 0.6, cross_object: 1.0 },
  },
  pretest_done: {
    taskType: 'pretest_done', expectedState: 'done', expectedDurationMin: 10,
    requiredEvidence: ['document'], confidenceThreshold: 0.85,
    evidenceWeights: { document: 1.0, snapshot: 0.85, qr_scan: 0.8, communication: 0.6, cross_object: 1.0 },
  },
  dilation_started: {
    taskType: 'dilation_started', expectedState: 'started',
    requiredEvidence: ['qr_scan'], confidenceThreshold: 0.8,
    evidenceWeights: { qr_scan: 1.0, snapshot: 0.8, document: 0.7, communication: 0.5, cross_object: 1.0 },
  },
  inventory_reorder: {
    taskType: 'inventory_reorder', expectedState: 'ordered',
    requiredEvidence: ['document'], confidenceThreshold: 0.85,
    evidenceWeights: { document: 1.0, communication: 0.8, snapshot: 0.6, qr_scan: 0.6, cross_object: 1.0 },
  },
  equipment_calibration: {
    taskType: 'equipment_calibration', expectedState: 'calibrated',
    requiredEvidence: ['document'], confidenceThreshold: 0.85,
    evidenceWeights: { document: 1.0, snapshot: 0.85, qr_scan: 0.7, communication: 0.5, cross_object: 1.0 },
  },
};

export function getSopConfig(taskType: string | undefined, overrides?: Partial<TaskSopConfig>): TaskSopConfig {
  const base: TaskSopConfig = (taskType && DEFAULT_SOP[taskType]) || {
    taskType: taskType ?? 'unknown',
    expectedState: 'done',
    requiredEvidence: [],
    confidenceThreshold: DEFAULT_THRESHOLD,
  };
  // Merge, but never let an undefined override clobber a good default (evidenceWeights/base).
  if (!overrides) return { ...base };
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined),
  ) as Partial<TaskSopConfig>;
  return { ...base, ...defined };
}
