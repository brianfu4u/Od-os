import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AssignableStaff,
  AssignmentOverview,
  AssignmentResult,
  CreateTaskInput,
  ManagerTaskRow,
  RejectionReasonCategory,
  TaskAssignee,
  TaskDecisionInput,
  TaskDecisionResult,
  TaskFlowState,
  TaskRejection,
} from '@clearview/shared';
import { isRejectionReasonCategory } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

/** A closed flow is terminal: no reopen, no re-decision. Repository throws this; the service maps to 409. */
export class FlowAlreadyClosedError extends Error {
  constructor(taskId: string) {
    super(`task flow already closed: ${taskId}`);
    this.name = 'FlowAlreadyClosedError';
  }
}

/** A reject decision without a valid structured category. Repository throws this; the service maps to 400. */
export class InvalidRejectionReasonError extends Error {
  constructor() {
    super('a rejection requires a valid rejectionReasonCategory');
    this.name = 'InvalidRejectionReasonError';
  }
}

/** Outcome of a manager decision, carrying enough for the service layer to publish the right SSE. */
export interface DecisionOutcome {
  result: TaskDecisionResult;
  /** The staff (employee) currently assigned to the task — for the real-time notification target. */
  employeeId: string | null;
  /** True only for approve/reject (employee-visible). SHELVE is silent — no employee signal. */
  notifyEmployee: boolean;
}

interface TaskRow {
  id: string;
  properties: Record<string, unknown>;
  claimed_state: string | null;
  verified_state: string | null;
  verification_score: string | null;
  updated_at: string;
  room_label: string | null;
  assignee_id: string | null;
  assignee_props: Record<string, unknown> | null;
  flow_id: string | null;
  flow_state: string | null;
  rej_payload: Record<string, unknown> | null;
  rej_at: string | null;
  rej_total: number | null;
}
interface StaffRow {
  id: string;
  properties: Record<string, unknown>;
}
interface ObjRow {
  id: string;
  properties: Record<string, unknown>;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
function displayOf(props: Record<string, unknown> | null | undefined): string | null {
  const p = props ?? {};
  return str(p.displayName) ?? str(p.staffHandle);
}

/**
 * Build a TaskRejection read projection from a `task.flow.rejected` event payload (+ its timestamp
 * and the total reject count for the flow). Returns null when there is no valid rejection on record.
 * Shared by the manager overview and the employee MyTasks projection so both surface the SAME reason.
 */
export function rejectionFrom(
  payload: Record<string, unknown> | null | undefined,
  at: string | null | undefined,
  total: number | null | undefined,
): TaskRejection | null {
  if (!payload || !at) return null;
  const category = payload.rejectionReasonCategory;
  if (!isRejectionReasonCategory(category)) return null;
  const detail = typeof payload.rejectionReasonDetail === 'string' && payload.rejectionReasonDetail
    ? payload.rejectionReasonDetail
    : null;
  return {
    category: category as RejectionReasonCategory,
    detail,
    at: new Date(at).toISOString(),
    count: Number(total ?? 1),
  };
}

/**
 * Manager task-assignment data access. Every method runs inside withTenant() (BEGIN; SET LOCAL ROLE
 * clearview_app; tenant GUC; COMMIT), so RLS is the tenant boundary and multi-statement writes are
 * ATOMIC. It writes ONLY: the assignedTo link (Staff→Task) and, for create, a Task's properties —
 * plus an append-only `events` row. It NEVER writes verified_state (owned by the S2 engine), and the
 * task + staff must resolve under the caller's tenant (RLS) or the op returns null → 404.
 */
@Injectable()
export class AssignmentRepository {
  /** This tenant's tasks (+ current assignee + room label) and assignable staff, for the UI. */
  overview(tenantId: string): Promise<AssignmentOverview> {
    return withTenant(tenantId, async (c) => {
      const tasksRes = await c.query<TaskRow>(
        `SELECT t.id, t.properties, t.claimed_state, t.verified_state, t.verification_score, t.updated_at,
                t.flow_id, t.flow_state,
                room.label AS room_label,
                a.staff_id AS assignee_id, a.staff_props AS assignee_props,
                rej.payload AS rej_payload, rej.created_at AS rej_at, rej.total AS rej_total
           FROM objects t
           LEFT JOIN LATERAL (
             SELECT s.id AS staff_id, s.properties AS staff_props
               FROM links la
               JOIN objects s ON s.id = la.from_object AND s.type = 'Staff'
              WHERE la.to_object = t.id AND la.relation = 'assignedTo'
              ORDER BY la.created_at DESC
              LIMIT 1
           ) a ON true
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
          LIMIT 200`,
      );
      const tasks: ManagerTaskRow[] = tasksRes.rows.map((r) => {
        const p = r.properties ?? {};
        const taskType = str(p.taskType);
        const assignee: TaskAssignee | null = r.assignee_id
          ? { staffId: r.assignee_id, displayName: displayOf(r.assignee_props) }
          : null;
        return {
          taskId: r.id,
          taskType,
          label: str(p.label) ?? r.room_label ?? taskType ?? 'Task',
          roomLabel: r.room_label ?? null,
          claimedState: r.claimed_state,
          verifiedState: r.verified_state,
          verificationScore: r.verification_score === null ? null : Number(r.verification_score),
          dueBy: str(p.dueBy),
          updatedAt: new Date(r.updated_at).toISOString(),
          assignee,
          flowState: r.flow_state === 'closed' ? 'closed' : r.flow_state === 'pending' ? 'pending' : null,
          flowId: r.flow_id ?? null,
          rejection: rejectionFrom(r.rej_payload, r.rej_at, r.rej_total),
        };
      });

      const staffRes = await c.query<StaffRow>(
        `SELECT id, properties FROM objects
          WHERE type = 'Staff' AND (properties->>'archived') IS DISTINCT FROM 'true'
          ORDER BY created_at ASC
          LIMIT 200`,
      );
      const staff: AssignableStaff[] = staffRes.rows.map((r) => {
        const p = r.properties ?? {};
        return { staffId: r.id, handle: str(p.staffHandle), displayName: str(p.displayName), role: str(p.role) };
      });

      return { tasks, staff };
    });
  }

  /**
   * Assign/reassign a task to a staff member (idempotent replace). Returns null when the task or the
   * staff does not resolve under this tenant (RLS) → the caller maps that to 404. Writes are atomic:
   * remove any prior assignedTo edge(s) to the task, insert the new one, and record an append-only
   * event. verified_state is never touched.
   */
  async assign(tenantId: string, taskId: string, staffId: string, actor: string): Promise<AssignmentResult | null> {
    return withTenant(tenantId, async (c) => {
      const task = await this.loadTyped(c, taskId, 'Task');
      const staff = await this.loadTyped(c, staffId, 'Staff');
      if (!task || !staff) return null;

      const prev = await c.query<{ from_object: string }>(
        `SELECT from_object FROM links WHERE to_object = $1 AND relation = 'assignedTo' ORDER BY created_at DESC LIMIT 1`,
        [taskId],
      );
      const previousStaffId = prev.rows[0]?.from_object ?? null;

      await c.query(`DELETE FROM links WHERE to_object = $1 AND relation = 'assignedTo'`, [taskId]);
      await c.query(
        `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, 'assignedTo')`,
        [tenantId, staffId, taskId],
      );
      await this.recordEvent(c, tenantId, taskId, 'task.assigned', { staffId, previousStaffId }, actor);

      return { taskId, assignee: { staffId, displayName: displayOf(staff.properties) } };
    });
  }

  /**
   * Create a Task (properties only — NO verified_state), optionally assigning it in the same
   * transaction. Returns null when an assignee is requested but does not resolve under this tenant.
   */
  async createTask(tenantId: string, input: CreateTaskInput, actor: string): Promise<AssignmentResult | null> {
    return withTenant(tenantId, async (c) => {
      let staff: ObjRow | null = null;
      if (input.staffId) {
        staff = await this.loadTyped(c, input.staffId, 'Staff');
        if (!staff) return null; // requested assignee not in this tenant → 404 (create nothing)
      }

      const properties: Record<string, unknown> = { label: input.label };
      if (input.taskType) properties.taskType = input.taskType;
      if (input.dueBy) properties.dueBy = input.dueBy;

      // A Task IS a flow. Create it in the initial `pending` flow state, then mint its flow_id equal
      // to its own object id (each task is its own flow, stable for the task's whole life). The flow
      // only ever moves to `closed` via an explicit manager APPROVE (assignments/tasks/:id/decide).
      const created = await c.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties, flow_state) VALUES ($1, 'Task', $2::jsonb, 'pending') RETURNING id`,
        [tenantId, JSON.stringify(properties)],
      );
      const taskId = created.rows[0]!.id;
      await c.query(`UPDATE objects SET flow_id = id WHERE id = $1`, [taskId]);
      await this.recordEvent(c, tenantId, taskId, 'object.created', { type: 'Task', by: 'manager', flowId: taskId }, actor);

      let assignee: TaskAssignee | null = null;
      if (staff && input.staffId) {
        await c.query(
          `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, 'assignedTo')`,
          [tenantId, input.staffId, taskId],
        );
        await this.recordEvent(c, tenantId, taskId, 'task.assigned', { staffId: input.staffId, previousStaffId: null }, actor);
        assignee = { staffId: input.staffId, displayName: displayOf(staff.properties) };
      }

      return { taskId, assignee };
    });
  }

  /**
   * The manager's SINGLE-AUTHORITY three-state decision on a task flow. This is the ONLY thing that
   * moves a flow's lifecycle. Runs atomically inside withTenant() (RLS). Returns null when the task
   * does not resolve under this tenant (→ 404).
   *
   *   APPROVE → flow_state = 'closed' (terminal, one-way). Appends `task.flow.closed`. Employee notified.
   *             Rejected (409) if the flow is already closed — a closed flow is NEVER reopened.
   *   REJECT  → flow stays 'pending' (SAME flow, not closed). Appends `task.flow.rejected` with the
   *             structured category (+ optional detail). Employee notified WITH the reason.
   *   SHELVE  → flow stays 'pending', stays in the manager's queue. Appends `task.flow.shelved`.
   *             NO employee notification (silent).
   *
   * verified_state is NEVER touched here — the S2 verdict is reference data, not the flow gate.
   */
  async decide(
    tenantId: string,
    taskId: string,
    input: TaskDecisionInput,
    managerActor: string,
  ): Promise<DecisionOutcome | null> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ flow_id: string | null; flow_state: string | null }>(
        `SELECT flow_id, flow_state FROM objects
          WHERE id = $1 AND type = 'Task' AND (properties->>'archived') IS DISTINCT FROM 'true' LIMIT 1`,
        [taskId],
      );
      const row = res.rows[0];
      if (!row) return null; // not in this tenant → 404

      // A flow may be missing flow_id/flow_state only for objects created before 0013 backfill in an
      // odd state; treat the task's own id as its flow id and an absent state as 'pending'.
      const flowId = row.flow_id ?? taskId;
      const currentState: TaskFlowState = row.flow_state === 'closed' ? 'closed' : 'pending';

      const employeeId = await this.currentAssignee(c, taskId);

      if (input.decision === 'approve') {
        if (currentState === 'closed') {
          // Guardrail: no reopening / re-closing. Signal a conflict; the service maps to 409.
          throw new FlowAlreadyClosedError(taskId);
        }
        await c.query(`UPDATE objects SET flow_state = 'closed' WHERE id = $1`, [taskId]);
        await this.recordEvent(
          c, tenantId, taskId, 'task.flow.closed',
          { flowId, employeeId, managerId: managerActor, decision: 'approve' },
          managerActor,
        );
        return {
          result: { taskId, flowId, flowState: 'closed', decision: 'approve' },
          employeeId,
          notifyEmployee: true,
        };
      }

      if (input.decision === 'reject') {
        const category = input.rejectionReasonCategory;
        if (!isRejectionReasonCategory(category)) {
          throw new InvalidRejectionReasonError();
        }
        // A closed flow cannot be rejected (it is terminal). Manager must not act on a closed flow.
        if (currentState === 'closed') {
          throw new FlowAlreadyClosedError(taskId);
        }
        const detail = typeof input.rejectionReasonDetail === 'string' && input.rejectionReasonDetail.trim()
          ? input.rejectionReasonDetail.trim()
          : null;
        const priorRejections = await this.rejectionCount(c, taskId);
        // Flow stays pending (same flow). Record the structured rejection on the append-only ledger.
        await this.recordEvent(
          c, tenantId, taskId, 'task.flow.rejected',
          {
            flowId,
            employeeId,
            managerId: managerActor,
            decision: 'reject',
            rejectionReasonCategory: category,
            rejectionReasonDetail: detail,
            count: priorRejections + 1,
          },
          managerActor,
        );
        // Touch updated_at so the employee's task list re-sorts / the SSE consumer refetches.
        await c.query(`UPDATE objects SET updated_at = now() WHERE id = $1`, [taskId]);
        return {
          result: { taskId, flowId, flowState: 'pending', decision: 'reject' },
          employeeId,
          notifyEmployee: true,
        };
      }

      // SHELVE — stays in the queue, unresolved, silent to the employee.
      if (currentState === 'closed') {
        throw new FlowAlreadyClosedError(taskId);
      }
      await this.recordEvent(
        c, tenantId, taskId, 'task.flow.shelved',
        { flowId, employeeId, managerId: managerActor, decision: 'shelve' },
        managerActor,
      );
      return {
        result: { taskId, flowId, flowState: 'pending', decision: 'shelve' },
        employeeId,
        notifyEmployee: false,
      };
    });
  }

  /** The task's current assignee staff id (most-recent assignedTo edge), or null if unassigned. */
  private async currentAssignee(c: PoolClient, taskId: string): Promise<string | null> {
    const res = await c.query<{ from_object: string }>(
      `SELECT from_object FROM links WHERE to_object = $1 AND relation = 'assignedTo' ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    return res.rows[0]?.from_object ?? null;
  }

  /** How many times this task's CURRENT open flow has been rejected (since the last closure / creation). */
  private async rejectionCount(c: PoolClient, taskId: string): Promise<number> {
    const res = await c.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM events WHERE object_id = $1 AND event_type = 'task.flow.rejected'`,
      [taskId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  /** Load an object by id + expected type, tenant-scoped (RLS) and excluding archived. */
  private async loadTyped(c: PoolClient, id: string, type: 'Task' | 'Staff'): Promise<ObjRow | null> {
    const res = await c.query<ObjRow>(
      `SELECT id, properties FROM objects
        WHERE id = $1 AND type = $2 AND (properties->>'archived') IS DISTINCT FROM 'true' LIMIT 1`,
      [id, type],
    );
    return res.rows[0] ?? null;
  }

  private async recordEvent(
    c: PoolClient,
    tenantId: string,
    objectId: string,
    eventType: string,
    payload: Record<string, unknown>,
    actor: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [tenantId, objectId, eventType, JSON.stringify(payload), actor],
    );
  }
}
