import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AttentionCandidate } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import { resolveAttentionConfig, type AttentionConfig } from './attention.config';
import { runAllRules, type EmployeeFactsSnapshot } from './rules/attention-rules';
import { ATTENTION_EVENT_CANDIDATE_GENERATED } from './attention.events';

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
 * rules, and return the resulting candidates. For EVERY candidate, append an
 * `attention.candidate.generated` event — the audit layer NEVER dedups (that is the queue display
 * layer's job, applied later in the service). The write is additive-only: no world state, no
 * claimed_status, no flow_state is ever mutated here, and NO employee-visible event is produced.
 */
@Injectable()
export class AttentionRepository {
  /** Generate candidates for all employees in the tenant AND audit-log every one. */
  async generateAndAudit(
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

      // T-10: log EVERY candidate (no dedup at the write layer). Manager-side actor; the object_id
      // is the employee the finding concerns, so the fact is traceable, but this is NOT an
      // employee-visible event and it changes no world state.
      for (const cand of candidates) {
        await c.query(
          `INSERT INTO events (tenant_id, object_id, event_type, payload, actor)
           VALUES ($1, $2, $3, $4::jsonb, $5)`,
          [
            tenantId,
            cand.employeeId,
            ATTENTION_EVENT_CANDIDATE_GENERATED,
            JSON.stringify({
              kind: cand.kind,
              evidenceSummary: cand.evidenceSummary,
              lastEventAt: cand.lastEventAt,
              generatedAt: cand.generatedAt,
            }),
            'manager',
          ],
        );
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
