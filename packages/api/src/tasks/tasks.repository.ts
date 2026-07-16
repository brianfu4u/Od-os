/**
 * T5 · "My tasks" data access — READ-ONLY, always inside withTenant() so RLS is the tenant boundary.
 * "Mine" = Tasks with an `assignedTo` link from the caller's own Staff object (the assignment model
 * already used by the seed + S3). No writes, and it reads the verdict straight from Task.verified_state
 * (deterministic S2) — LLM/heuristics never participate.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { MyTaskSummary } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import type { SessionIdentity } from '../auth/session.types';
import { rejectionFrom } from '../assignments/assignment.repository';

interface TaskRow {
  id: string;
  properties: Record<string, unknown>;
  expected_state: string | null;
  claimed_state: string | null;
  verified_state: string | null;
  verification_score: string | null;
  updated_at: string;
  room_label: string | null;
  flow_state: string | null;
  rej_payload: Record<string, unknown> | null;
  rej_at: string | null;
  rej_total: number | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function mapTask(r: TaskRow): MyTaskSummary {
  const p = r.properties ?? {};
  const taskType = str(p.taskType);
  const flowState = r.flow_state === 'closed' ? 'closed' : r.flow_state === 'pending' ? 'pending' : null;
  // The employee only sees a rejection banner while the flow is OPEN (pending). Once APPROVED
  // (closed) the task is done and the (historical) rejection is no longer surfaced as an action.
  const rejection = flowState === 'pending' ? rejectionFrom(r.rej_payload, r.rej_at, r.rej_total) : null;
  return {
    taskId: r.id,
    taskType,
    label: str(p.label) ?? r.room_label ?? taskType ?? 'Task',
    roomLabel: r.room_label ?? null,
    expectedState: r.expected_state,
    claimedState: r.claimed_state,
    verifiedState: r.verified_state,
    verificationScore: r.verification_score === null ? null : Number(r.verification_score),
    dueBy: str(p.dueBy),
    updatedAt: new Date(r.updated_at).toISOString(),
    flowState,
    rejection,
  };
}

@Injectable()
export class TasksRepository {
  /**
   * List the Tasks assigned to the caller. Resolves the caller's Staff id from the session
   * (`staffId` for a real session; a dev shim resolves by `staffHandle`), then returns Tasks joined
   * via `assignedTo` — RLS scopes everything to the tenant, and the from_object filter scopes to the
   * one staff, so results never cross tenants OR staff. Empty when the caller has no resolvable staff.
   */
  listMine(tenantId: string, identity: SessionIdentity | undefined): Promise<MyTaskSummary[]> {
    return withTenant(tenantId, async (c) => {
      const staffId = await this.resolveStaffId(c, identity);
      if (!staffId) return [];
      const res = await c.query<TaskRow>(
        `SELECT t.id, t.properties, t.expected_state, t.claimed_state, t.verified_state, t.verification_score, t.updated_at,
                t.flow_state,
                room.label AS room_label,
                rej.payload AS rej_payload, rej.created_at AS rej_at, rej.total AS rej_total
           FROM objects t
           JOIN links la ON la.to_object = t.id AND la.relation = 'assignedTo' AND la.from_object = $1
           LEFT JOIN LATERAL (
             SELECT r.properties->>'label' AS label
               FROM links lr
               JOIN objects r ON r.id = lr.to_object AND r.type = 'Room'
              WHERE lr.from_object = t.id AND lr.relation = 'references'
              ORDER BY r.created_at ASC
              LIMIT 1
           ) room ON true
           LEFT JOIN LATERAL (
             SELECT e.payload, e.created_at,
                    (SELECT COUNT(*) FROM events WHERE object_id = t.id AND event_type = 'task.flow.rejected')::int AS total
               FROM events e
              WHERE e.object_id = t.id AND e.event_type = 'task.flow.rejected'
              ORDER BY e.created_at DESC
              LIMIT 1
           ) rej ON true
          WHERE t.type = 'Task'
            AND (t.properties->>'archived') IS DISTINCT FROM 'true'
          ORDER BY t.updated_at DESC
          LIMIT 100`,
        [staffId],
      );
      return res.rows.map(mapTask);
    });
  }

  /** Resolve the caller's Staff object id: real session `staffId`, else the dev-shim `staffHandle`. */
  private async resolveStaffId(c: PoolClient, identity: SessionIdentity | undefined): Promise<string | null> {
    if (!identity) return null;
    if (identity.staffId) {
      const ex = await c.query(`SELECT 1 FROM objects WHERE id = $1 AND type = 'Staff'`, [identity.staffId]);
      if (ex.rows[0]) return identity.staffId;
      return null;
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
