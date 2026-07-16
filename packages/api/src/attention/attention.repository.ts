import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AttentionCandidate } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import { resolveAttentionConfig, type AttentionConfig } from './attention.config';
import { runAllRules, type EmployeeFactsSnapshot } from './rules/attention-rules';

/** Whitelist of "activity progress" event types that refresh follow-up (mirrors freshness). */
const PROGRESS_EVENT_TYPES = [
  'employee.status.claimed',
  'patient.scanned',
  'task.flow.closed',
  'task.flow.rejected',
  'task.flow.shelved',
  'patient.flow.advanced',
];

interface FactsRow {
  employee_id: string;
  employee_name: string | null;
  claimed_status: string | null;
  last_event_at: string | null;
  secs_since_event: string | null;
  last_scan_at: string | null;
  last_scan_code: string | null;
  secs_since_scan: string | null;
  secs_since_followup: string | null;
  verification_result: string | null;
  verification_score: string | null;
}

/**
 * T-06/T-07/T-10 data access for the attention queue. Runs inside withTenant() (RLS-scoped, atomic).
 *
 * Read-time model (no stored queue table): assemble every Staff member's facts from the freshness
 * view + latest scan + latest claim's verification layer + follow-up progress, run the four pure
 * rules, and return the resulting candidates. Pure READ: no world state, no claimed_status, no
 * flow_state, and NO event of any kind is written here.
 *
 * P1-5 (intentional design change, NOT a bug fix): the previous T-10 behavior wrote one
 * `attention.candidate.generated` event per candidate on EVERY read of GET /attention/queue. That
 * read-time audit write was removed because (1) nothing downstream consumed those events (no cron,
 * SSE, web, or service read them — they were write-only), and (2) it violated the attention queue's
 * read-only definition (a GET must never mutate). If a candidate-generation audit trail is needed in
 * future, it belongs on an actual write operation (claim / verify / scan), not on a read.
 */
@Injectable()
export class AttentionRepository {
  /** Generate candidates for all employees in the tenant. Pure read — writes nothing. */
  async generate(
    tenantId: string,
    env: Record<string, string | undefined> = process.env,
  ): Promise<{ candidates: AttentionCandidate[]; config: AttentionConfig }> {
    const config = resolveAttentionConfig(env);
    return withTenant(tenantId, async (c) => {
      const facts = await this.readFacts(c);
      const nowIso = new Date().toISOString();

      const candidates: AttentionCandidate[] = [];
      for (const row of facts) {
        const snapshot = this.toSnapshot(row, nowIso);
        const fired = runAllRules(snapshot, config);
        candidates.push(...fired);
      }

      return { candidates, config };
    });
  }

  private toSnapshot(row: FactsRow, nowIso: string): EmployeeFactsSnapshot {
    const num = (v: string | null): number | null => (v === null ? null : Number(v));
    return {
      employeeId: row.employee_id,
      employeeName: row.employee_name ?? row.employee_id,
      claimedStatus: row.claimed_status,
      lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
      secondsSinceLastEvent: num(row.secs_since_event),
      lastScanAt: row.last_scan_at ? new Date(row.last_scan_at).toISOString() : null,
      lastScanCode: row.last_scan_code,
      secondsSinceLastScan: num(row.secs_since_scan),
      secondsSinceScanFollowup: num(row.secs_since_followup),
      verificationResult: row.verification_result,
      verificationScore:
        row.verification_score === null ? null : Number(row.verification_score),
      nowIso,
    };
  }

  /**
   * Assemble one row of facts per Staff object. All sub-selects are correlated on the same employee
   * and tenant-scoped by RLS. `secs_since_followup` is seconds since the newest PROGRESS event that
   * is strictly later than the newest scan (null ⇒ no progress since that scan).
   */
  private async readFacts(c: PoolClient): Promise<FactsRow[]> {
    const progressList = PROGRESS_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
    const res = await c.query<FactsRow>(
      `WITH staff AS (
         SELECT id, COALESCE(properties->>'displayName', properties->>'staffHandle', id::text) AS name,
                claimed_state
           FROM objects
          WHERE type = 'Staff'
       ),
       fresh AS (
         SELECT employee_id, last_event_at FROM employee_freshness
       ),
       last_scan AS (
         SELECT DISTINCT ON (employee_id) employee_id, scanned_at, patient_code
           FROM patient_scans
          ORDER BY employee_id, scanned_at DESC
       ),
       last_claim AS (
         SELECT DISTINCT ON (employee_id) employee_id, verification_result, verification_score
           FROM employee_status_claims
          ORDER BY employee_id, claimed_at DESC
       )
       SELECT
         s.id                                                        AS employee_id,
         s.name                                                      AS employee_name,
         s.claimed_state                                             AS claimed_status,
         f.last_event_at                                             AS last_event_at,
         CASE WHEN f.last_event_at IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (now() - f.last_event_at)) END AS secs_since_event,
         ls.scanned_at                                               AS last_scan_at,
         ls.patient_code                                             AS last_scan_code,
         CASE WHEN ls.scanned_at IS NULL THEN NULL
              ELSE EXTRACT(EPOCH FROM (now() - ls.scanned_at)) END   AS secs_since_scan,
         (
           SELECT EXTRACT(EPOCH FROM (now() - MAX(e.created_at)))
             FROM events e
            WHERE e.object_id = s.id
              AND e.event_type IN (${progressList})
              AND ls.scanned_at IS NOT NULL
              AND e.created_at > ls.scanned_at
         )                                                           AS secs_since_followup,
         lc.verification_result                                      AS verification_result,
         lc.verification_score                                  AS verification_score
       FROM staff s
       LEFT JOIN fresh f      ON f.employee_id = s.id
       LEFT JOIN last_scan ls ON ls.employee_id = s.id
       LEFT JOIN last_claim lc ON lc.employee_id = s.id`,
    );
    return res.rows;
  }
}
