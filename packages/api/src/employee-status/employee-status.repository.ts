import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EmployeeStatus, EmployeeStatusView, StatusBoardRow } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import type { SessionIdentity } from '../auth/session.types';

/** A claim result plus the SERVER-RESOLVED employee id (for a correctly-targeted SSE broadcast). */
export interface ClaimResult {
  view: EmployeeStatusView;
  employeeId: string;
}

/** The caller has no resolvable Staff object in this tenant (no session staffId / handle). → 403/404. */
export class NoStaffIdentityError extends Error {
  constructor() {
    super('no staff identity for the caller in this tenant');
    this.name = 'NoStaffIdentityError';
  }
}

interface ClaimRow {
  claimed_status: string;
  note: string | null;
  claimed_at: string;
}

interface BoardRow {
  employee_id: string;
  employee_name: string | null;
  claimed_status: string | null;
  last_event_at: string | null;
  secs_since_event: string | number | null;
}

/**
 * T-04 data access for employee work-status CLAIMS. Every method runs inside withTenant() (BEGIN;
 * SET LOCAL ROLE clearview_app; tenant GUC; COMMIT), so RLS is the tenant boundary and the
 * multi-statement write is ATOMIC.
 *
 * The write path is deliberately three-in-one and NEVER rejects a valid five-state claim:
 *   1) UPDATE the Staff object's claimed_state  → current status (world state, CLAIM layer only)
 *   2) INSERT an append-only row into employee_status_claims → immutable claim history
 *   3) INSERT an append-only `employee.status.claimed` event, carrying the claim_id in the payload
 *      (the scan_id/claim_id hard-link convention: payload jsonb references the ledger row so a
 *      future Correlator can precisely trace a claim event back to its rich row — zero migration).
 *
 * verification_result / verification_confidence are NEVER written here — they are filled later by a
 * silent background check, are manager-side reference only, and never flow back to the employee.
 */
@Injectable()
export class EmployeeStatusRepository {
  /**
   * Record a status claim for the CALLER's own Staff object (server-derived id — never client
   * supplied). Returns the employee-facing view (CLAIM layer only). Throws NoStaffIdentityError
   * when the caller has no resolvable Staff object in this tenant.
   */
  async submitClaim(
    tenantId: string,
    identity: SessionIdentity | undefined,
    claimedStatus: EmployeeStatus,
    note: string | null,
    claimedAt: string | null,
  ): Promise<ClaimResult> {
    return withTenant(tenantId, async (c) => {
      const employeeId = await this.resolveStaffId(c, identity);
      if (!employeeId) throw new NoStaffIdentityError();

      // 2) append-only claim history (source of truth for "what the employee said, when").
      const inserted = await c.query<{ id: string; claimed_at: string }>(
        `INSERT INTO employee_status_claims (tenant_id, employee_id, claimed_status, claim_source, note, claimed_at)
         VALUES ($1, $2, $3, 'button', $4, COALESCE($5::timestamptz, now()))
         RETURNING id, claimed_at`,
        [tenantId, employeeId, claimedStatus, note, claimedAt],
      );
      const claimId = inserted.rows[0]!.id;
      const storedClaimedAt = inserted.rows[0]!.claimed_at;

      // 1) project the current status onto the Staff object (CLAIM layer column only).
      await c.query(`UPDATE objects SET claimed_state = $2 WHERE id = $1 AND type = 'Staff'`, [
        employeeId,
        claimedStatus,
      ]);

      // 3) append-only event, hard-linking the claim row via payload.claimId (Correlator anchor).
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor)
         VALUES ($1, $2, 'employee.status.claimed', $3::jsonb, $4)`,
        [tenantId, employeeId, JSON.stringify({ claimId, claimedStatus }), 'employee'],
      );

      return {
        view: {
          claimedStatus,
          note: note && note.trim() ? note : null,
          claimedAt: new Date(storedClaimedAt).toISOString(),
        },
        employeeId,
      };
    });
  }

  /**
   * The caller's own CURRENT status view (CLAIM layer only). Reads the latest claim row for the
   * caller's Staff object. Returns nulls when the employee has never claimed a status. NEVER returns
   * verification_result / verification_confidence — the field-projection guarantee (T-11).
   */
  async currentForCaller(
    tenantId: string,
    identity: SessionIdentity | undefined,
  ): Promise<EmployeeStatusView> {
    return withTenant(tenantId, async (c) => {
      const employeeId = await this.resolveStaffId(c, identity);
      if (!employeeId) throw new NoStaffIdentityError();

      const res = await c.query<ClaimRow>(
        `SELECT claimed_status, note, claimed_at
           FROM employee_status_claims
          WHERE employee_id = $1
          ORDER BY claimed_at DESC
          LIMIT 1`,
        [employeeId],
      );
      const row = res.rows[0];
      if (!row) return { claimedStatus: null, note: null, claimedAt: null };
      return {
        claimedStatus: row.claimed_status as EmployeeStatus,
        note: row.note,
        claimedAt: new Date(row.claimed_at).toISOString(),
      };
    });
  }

  /**
   * MANAGER-side whole-roster status board (T-09 · D1-A). One row per in-roster Staff, joining the
   * CLAIM layer (claimed_state on the Staff object) with the read-time freshness OBSERVATION
   * (employee_freshness view). READ-ONLY: opens no write, mutates no world_state / claimed_status /
   * flow_state, and appends NO event — unlike the attention queue this is a pure snapshot with no
   * audit side-effect. NEVER selects verification_result / verification_confidence (field-projection
   * guarantee). RLS scopes it to the caller's tenant. Employees with no valid event yet have
   * last_event_at = null; consumers treat null freshness as "stale".
   */
  async statusBoard(tenantId: string): Promise<StatusBoardRow[]> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<BoardRow>(
        `SELECT
           s.id                                                        AS employee_id,
           COALESCE(s.properties->>'displayName', s.properties->>'staffHandle', s.id::text) AS employee_name,
           s.claimed_state                                             AS claimed_status,
           f.last_event_at                                             AS last_event_at,
           CASE WHEN f.last_event_at IS NULL THEN NULL
                ELSE EXTRACT(EPOCH FROM (now() - f.last_event_at)) END  AS secs_since_event
           FROM objects s
           LEFT JOIN employee_freshness f ON f.employee_id = s.id
          WHERE s.type = 'Staff'
          ORDER BY employee_name ASC`,
      );
      return res.rows.map((row) => ({
        employeeId: row.employee_id,
        employeeName: row.employee_name ?? row.employee_id,
        claimedStatus: row.claimed_status,
        lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
        secondsSinceLastEvent:
          row.secs_since_event === null ? null : Math.floor(Number(row.secs_since_event)),
      }));
    });
  }

  /**
   * Resolve the caller's own Staff object id: a real session `staffId`, else the dev-shim
   * `staffHandle`. Mirrors TasksRepository.resolveStaffId so status + tasks agree in dev/CI/prod.
   * The server NEVER trusts a client-supplied staff id.
   */
  private async resolveStaffId(c: PoolClient, identity: SessionIdentity | undefined): Promise<string | null> {
    if (!identity) return null;
    if (identity.staffId) {
      const ex = await c.query(`SELECT 1 FROM objects WHERE id = $1 AND type = 'Staff'`, [identity.staffId]);
      return ex.rows[0] ? identity.staffId : null;
    }
    if (identity.staffHandle) {
      const res = await c.query<{ id: string }>(
        `SELECT id FROM objects WHERE type = 'Staff' AND properties->>'staffHandle' = $1 LIMIT 1`,
        [identity.staffHandle],
      );
      return res.rows[0]?.id ?? null;
    }
    return null;
  }
}
