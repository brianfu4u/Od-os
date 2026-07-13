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

interface TaskRow {
  id: string;
  properties: Record<string, unknown>;
  expected_state: string | null;
  claimed_state: string | null;
  verified_state: string | null;
  confidence: string | null;
  updated_at: string;
  room_label: string | null;
  /** count of append-only `task.resubmission.requested` events for this task. */
  resubmission_count: string | null;
  /** payload of the MOST RECENT resubmission request (jsonb), or null. */
  last_resubmission: { verifiedState?: string; requiredMissing?: unknown; reason?: string; attempt?: number } | null;
  /** count of `task.resubmission.escalated` markers (>0 ⇒ the loop escalated to a manager). */
  escalated_count: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function mapTask(r: TaskRow): MyTaskSummary {
  const p = r.properties ?? {};
  const taskType = str(p.taskType);
  return {
    taskId: r.id,
    taskType,
    label: str(p.label) ?? r.room_label ?? taskType ?? 'Task',
    roomLabel: r.room_label ?? null,
    expectedState: r.expected_state,
    claimedState: r.claimed_state,
    verifiedState: r.verified_state,
    confidence: r.confidence === null ? null : Number(r.confidence),
    dueBy: str(p.dueBy),
    updatedAt: new Date(r.updated_at).toISOString(),
    ...resubmissionFields(r),
  };
}

/**
 * Derive the READ-ONLY resubmission projection from the task row's resubmission-event columns.
 *
 * Two terminal, MUTUALLY EXCLUSIVE staff-facing states while a task is still non-verified:
 *   • `escalatedToManager` — the task exhausted its staff bounce-backs (a `.escalated` marker
 *     exists). The staff has NO further action; the manager now owns it. Takes precedence.
 *   • `needsResubmission` — within the cap: the task was bounced back and the verdict is still
 *     non-verified, so the staff should add evidence and resubmit.
 * A subsequent verified verdict closes the loop and clears BOTH flags without deleting the
 * append-only audit trail (the counts survive).
 */
function resubmissionFields(r: TaskRow): Pick<
  MyTaskSummary,
  'needsResubmission' | 'requiredMissing' | 'resubmissionCount' | 'lastResubmissionReason' | 'escalatedToManager'
> {
  const count = Number(r.resubmission_count ?? 0);
  const escalatedCount = Number(r.escalated_count ?? 0);
  const last = r.last_resubmission ?? null;
  const stillUnverified = r.verified_state !== 'verified';
  const escalatedToManager = escalatedCount > 0 && stillUnverified;
  // Once escalated, stop asking the staff to resubmit (the ball is in the manager's court).
  const needsResubmission = !escalatedToManager && count > 0 && stillUnverified;
  const requiredMissing =
    last && Array.isArray(last.requiredMissing)
      ? last.requiredMissing.filter((k): k is string => typeof k === 'string')
      : [];
  return {
    needsResubmission,
    requiredMissing: needsResubmission ? requiredMissing : [],
    resubmissionCount: count,
    lastResubmissionReason: last && typeof last.reason === 'string' ? last.reason : null,
    escalatedToManager,
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
        `SELECT t.id, t.properties, t.expected_state, t.claimed_state, t.verified_state, t.confidence, t.updated_at,
                room.label AS room_label,
                resub.n AS resubmission_count,
                resub.last_payload AS last_resubmission,
                esc.n AS escalated_count
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
             SELECT count(*) AS n,
                    (SELECT e2.payload
                       FROM events e2
                      WHERE e2.object_id = t.id AND e2.event_type = 'task.resubmission.requested'
                      ORDER BY e2.created_at DESC
                      LIMIT 1) AS last_payload
               FROM events e
              WHERE e.object_id = t.id AND e.event_type = 'task.resubmission.requested'
           ) resub ON true
           LEFT JOIN LATERAL (
             SELECT count(*) AS n
               FROM events e3
              WHERE e3.object_id = t.id AND e3.event_type = 'task.resubmission.escalated'
           ) esc ON true
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
