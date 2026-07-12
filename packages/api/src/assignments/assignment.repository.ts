import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AssignableStaff,
  AssignmentOverview,
  AssignmentResult,
  CreateTaskInput,
  ManagerTaskRow,
  TaskAssignee,
} from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

interface TaskRow {
  id: string;
  properties: Record<string, unknown>;
  claimed_state: string | null;
  verified_state: string | null;
  confidence: string | null;
  updated_at: string;
  room_label: string | null;
  assignee_id: string | null;
  assignee_props: Record<string, unknown> | null;
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
        `SELECT t.id, t.properties, t.claimed_state, t.verified_state, t.confidence, t.updated_at,
                room.label AS room_label,
                a.staff_id AS assignee_id, a.staff_props AS assignee_props
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
          confidence: r.confidence === null ? null : Number(r.confidence),
          dueBy: str(p.dueBy),
          updatedAt: new Date(r.updated_at).toISOString(),
          assignee,
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

      const created = await c.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Task', $2::jsonb) RETURNING id`,
        [tenantId, JSON.stringify(properties)],
      );
      const taskId = created.rows[0]!.id;
      await this.recordEvent(c, tenantId, taskId, 'object.created', { type: 'Task', by: 'manager' }, actor);

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
