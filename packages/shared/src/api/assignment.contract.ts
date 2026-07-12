/**
 * Manager task assignment contract (feat/manager-task-assign) — shapes shared by api + web for the
 * command-center assignment view. Assignment is modelled as the existing `assignedTo` link
 * (Staff → Task) that T5's /tasks/mine consumes; nothing here introduces a new state or touches
 * verified_state (owned by the deterministic S2 engine).
 */

/** A staff member the manager can assign work to (tenant-scoped). */
export interface AssignableStaff {
  staffId: string;
  handle: string | null;
  displayName: string | null;
  role: string | null;
}

/** The current assignee of a task (resolved from its assignedTo link), or null if unassigned. */
export interface TaskAssignee {
  staffId: string;
  displayName: string | null;
}

/** A tenant Task as shown in the manager assignment view. verifiedState is READ-ONLY (S2). */
export interface ManagerTaskRow {
  taskId: string;
  taskType: string | null;
  label: string;
  roomLabel: string | null;
  claimedState: string | null;
  verifiedState: string | null;
  confidence: number | null;
  dueBy: string | null;
  updatedAt: string;
  assignee: TaskAssignee | null;
}

/** Everything the assignment UI needs in one read: this tenant's tasks (+ current assignee) + staff. */
export interface AssignmentOverview {
  tasks: ManagerTaskRow[];
  staff: AssignableStaff[];
}

/** Assign/reassign a task to a staff member (both must belong to the caller's tenant). */
export interface AssignTaskInput {
  taskId: string;
  staffId: string;
}

/** Create a Task (properties only; never a verified_state), optionally assigning it immediately. */
export interface CreateTaskInput {
  taskType?: string | null;
  label: string;
  dueBy?: string | null;
  staffId?: string | null;
}

/** Result of an assign/create — the task id + its (new) assignee. */
export interface AssignmentResult {
  taskId: string;
  assignee: TaskAssignee | null;
}
