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
  /** Flow lifecycle: `pending` (awaiting a decision) or `closed` (approved, terminal). */
  flowState: TaskFlowState | null;
  /** Stable flow id (equals the task id for the task's whole life). */
  flowId: string | null;
  /** Last rejection in the current open flow (audit context for the manager), or null. */
  rejection: TaskRejection | null;
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

// ---------------------------------------------------------------------------
// Task-flow closure model (feat/flow-id-manager-decision)
// "One task = one flow, from creation to closure." The manager is the SOLE
// decision authority; there is no automatic escalation. The flow closes ONLY
// on an explicit APPROVE. REJECT (any number of times) resets it to pending
// within the SAME flow. SHELVE leaves it in the queue with no employee signal.
// ---------------------------------------------------------------------------

/** Task flow lifecycle state. `pending` = open for a manager decision; `closed` = terminal (APPROVE only). */
export type TaskFlowState = 'pending' | 'closed';

/** The three — and only three — manager decisions on a task flow. */
export type ManagerDecision = 'approve' | 'reject' | 'shelve';

/**
 * Structured rejection reason category (enum, not free text). The optional `detail` carries the
 * manager's free-text elaboration shown to the employee on resubmission — but the CATEGORY is the
 * queryable, structured field. These describe THIS submission's gaps only — never a judgment about
 * the person (system neutrality: "只摆事实,不建议对错").
 */
export const REJECTION_REASON_CATEGORIES = [
  'missing_evidence',      // required evidence not attached / insufficient
  'evidence_unclear',      // evidence present but not legible / ambiguous
  'wrong_task',            // submission does not match the assigned task
  'incomplete_work',       // the work itself is not finished
  'needs_more_detail',     // more context/explanation required
  'other',                 // see rejection_reason_detail
] as const;
export type RejectionReasonCategory = (typeof REJECTION_REASON_CATEGORIES)[number];

export function isRejectionReasonCategory(v: unknown): v is RejectionReasonCategory {
  return typeof v === 'string' && (REJECTION_REASON_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Manager decision input. `decision` is required. On `reject`, `rejectionReasonCategory` is REQUIRED
 * (structured) and `rejectionReasonDetail` is OPTIONAL (free-text, shown to the employee). Both are
 * ignored for approve/shelve.
 */
export interface TaskDecisionInput {
  decision: ManagerDecision;
  rejectionReasonCategory?: RejectionReasonCategory | null;
  rejectionReasonDetail?: string | null;
}

/** Result of a manager decision — the task id, its resulting flow state, and the flow id. */
export interface TaskDecisionResult {
  taskId: string;
  flowId: string;
  flowState: TaskFlowState;
  decision: ManagerDecision;
}

/**
 * The rejection context an employee sees on their task after a REJECT (read projection of the last
 * rejection event). Null when the task has never been rejected in its current (open) flow.
 */
export interface TaskRejection {
  category: RejectionReasonCategory;
  detail: string | null;
  /** ISO-8601 timestamp of the rejection. */
  at: string;
  /** How many times this flow has been rejected (audit; not a score, not a cap). */
  count: number;
}
