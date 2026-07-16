/**
 * T-07 · attention candidate generators — FOUR pure functions.
 *
 * Each rule is a pure function of a read-time facts snapshot for ONE employee → zero or one
 * candidate. Rules NEVER change world state, NEVER write flow_state, NEVER touch claimed_status,
 * and NEVER produce anything the employee can see. They only "state facts": a candidate carries a
 * neutral evidenceSummary, never a verdict/instruction/score.
 *
 * The queue service (T-06) feeds each employee's snapshot through `runAllRules`, logs every
 * resulting candidate (T-10, no dedup), then applies display-layer dedup/cooldown for the manager.
 */
import type {
  AttentionCandidate,
  AttentionEvidenceSummary,
  AttentionKind,
} from '@clearview/shared';
import type { AttentionConfig } from '../attention.config';

/**
 * The per-employee facts a rule reads. Assembled read-time by the repository from the freshness
 * view, employee_status_claims, and the events ledger — all tenant-scoped via RLS.
 */
export interface EmployeeFactsSnapshot {
  employeeId: string;
  employeeName: string;
  /** Self-declared status (CLAIM layer), or null if never claimed. */
  claimedStatus: string | null;
  /** ISO of the most recent VALID (freshness-whitelisted) event, or null. */
  lastEventAt: string | null;
  /** Seconds since the last valid event; null ⇒ treat as "stale / no activity yet". */
  secondsSinceLastEvent: number | null;
  /** ISO of the most recent patient scan by this employee, or null. */
  lastScanAt: string | null;
  /** The raw code of the most recent scan (a "submitted" fact), or null. */
  lastScanCode: string | null;
  /** Seconds since the last scan; null ⇒ no scan on record. */
  secondsSinceLastScan: number | null;
  /**
   * Seconds since the last patient-flow-progress event AFTER the last scan; null ⇒ no progress
   * observed since that scan. Progress = any freshness-whitelisted flow/scan event later than
   * lastScanAt. Used only by scan_no_followup.
   */
  secondsSinceScanFollowup: number | null;
  /** Latest silent consistency verdict for this employee's status, or null if unchecked. */
  verificationResult: string | null;
  /** Latest silent consistency verification score (0..1), or null if unchecked. */
  verificationScore: number | null;
  /** Read-time "now" as ISO, used as generatedAt. */
  nowIso: string;
}

function candidate(
  facts: EmployeeFactsSnapshot,
  kind: AttentionKind,
  evidence: AttentionEvidenceSummary,
): AttentionCandidate {
  return {
    employeeId: facts.employeeId,
    employeeName: facts.employeeName,
    kind,
    evidenceSummary: evidence,
    lastEventAt: facts.lastEventAt,
    generatedAt: facts.nowIso,
  };
}

/**
 * Rule 1 · silence: employee CLAIMS on_duty but no valid event for longer than the silence
 * threshold. A null secondsSinceLastEvent (never any valid event) while on_duty also counts.
 */
export function ruleSilence(
  facts: EmployeeFactsSnapshot,
  cfg: AttentionConfig,
): AttentionCandidate | null {
  if (facts.claimedStatus !== 'on_duty') return null;
  const secs = facts.secondsSinceLastEvent;
  const stale = secs === null || secs > cfg.silenceSeconds;
  if (!stale) return null;
  return candidate(facts, 'silence', {
    who: facts.employeeName,
    when: facts.lastEventAt,
    claimed: facts.claimedStatus,
    submitted: null,
    systemObserved:
      secs === null
        ? 'no valid activity event on record'
        : `${Math.round(secs)}s since last valid event (threshold ${cfg.silenceSeconds}s)`,
  });
}

/**
 * Rule 2 · status_inconsistency: employee CLAIMS busy but there is no corroborating activity within
 * the busy window (no valid event recently). "Busy" should be visible in the activity stream.
 */
export function ruleStatusInconsistency(
  facts: EmployeeFactsSnapshot,
  cfg: AttentionConfig,
): AttentionCandidate | null {
  if (facts.claimedStatus !== 'busy') return null;
  const secs = facts.secondsSinceLastEvent;
  const noActivity = secs === null || secs > cfg.busyInconsistencySeconds;
  if (!noActivity) return null;
  return candidate(facts, 'status_inconsistency', {
    who: facts.employeeName,
    when: facts.lastEventAt,
    claimed: facts.claimedStatus,
    submitted: null,
    systemObserved:
      secs === null
        ? 'claims busy but no valid activity event on record'
        : `claims busy but ${Math.round(secs)}s since last activity (window ${cfg.busyInconsistencySeconds}s)`,
  });
}

/**
 * Rule 3 · scan_no_followup: a scan happened, but no patient-flow progress within the follow-up
 * window after that scan. Fires only when there IS a scan on record.
 */
export function ruleScanNoFollowup(
  facts: EmployeeFactsSnapshot,
  cfg: AttentionConfig,
): AttentionCandidate | null {
  if (facts.secondsSinceLastScan === null) return null; // no scan → rule inapplicable
  const followup = facts.secondsSinceScanFollowup;
  // No progress since the scan (null) OR progress older than the window → stale follow-up.
  const stale = followup === null && facts.secondsSinceLastScan > cfg.scanFollowupSeconds;
  if (!stale) return null;
  return candidate(facts, 'scan_no_followup', {
    who: facts.employeeName,
    when: facts.lastScanAt,
    claimed: facts.claimedStatus,
    submitted: facts.lastScanCode,
    systemObserved: `${Math.round(
      facts.secondsSinceLastScan,
    )}s since scan with no patient-flow progress (window ${cfg.scanFollowupSeconds}s)`,
  });
}

/**
 * Rule 4 · low_confidence: the silent consistency check verdict is 'inconsistent', OR its confidence
 * is below the threshold. This reads the MANAGER-SIDE verification layer only — it never flows back
 * to the employee.
 */
export function ruleLowConfidence(
  facts: EmployeeFactsSnapshot,
  cfg: AttentionConfig,
): AttentionCandidate | null {
  const verdict = facts.verificationResult;
  const conf = facts.verificationScore;
  const inconsistent = verdict === 'inconsistent';
  const belowFloor = conf !== null && conf < cfg.lowConfidenceThreshold;
  if (!inconsistent && !belowFloor) return null;
  return candidate(facts, 'low_confidence', {
    who: facts.employeeName,
    when: facts.lastEventAt,
    claimed: facts.claimedStatus,
    submitted: null,
    systemObserved: inconsistent
      ? "consistency check verdict: 'inconsistent'"
      : `consistency confidence ${conf} below threshold ${cfg.lowConfidenceThreshold}`,
  });
}

/** Every P0 rule, in a stable order. */
export const ATTENTION_RULES = [
  ruleSilence,
  ruleStatusInconsistency,
  ruleScanNoFollowup,
  ruleLowConfidence,
] as const;

/** Run every rule for one employee snapshot; return all fired candidates (0..4). */
export function runAllRules(
  facts: EmployeeFactsSnapshot,
  cfg: AttentionConfig,
): AttentionCandidate[] {
  const out: AttentionCandidate[] = [];
  for (const rule of ATTENTION_RULES) {
    const c = rule(facts, cfg);
    if (c) out.push(c);
  }
  return out;
}
