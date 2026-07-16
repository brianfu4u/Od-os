/**
 * S1-1 object API contract (the S0-4 read/write shapes the frontend + later
 * tickets build against). Kept in @clearview/shared so api and web share one source.
 */
import type { TaskFlowState, TaskRejection } from './assignment.contract';

/**
 * Create a new ontology object. `type` is required; per-type fields go in `properties`.
 *
 * P0-1: `verifiedState` / `verificationScore` are intentionally NOT writable here. The verdict is
 * owned by the deterministic S2 Verification Service; it is the only writer (enforced at the API,
 * DTO, and DB layers). Callers set only the claim/expectation; verification is computed, never
 * asserted.
 */
export interface CreateObjectInput {
  type: string;
  properties?: Record<string, unknown>;
  expectedState?: string | null;
  claimedState?: string | null;
}

/**
 * Partial update. Any provided state field is set; `properties` are shallow-merged.
 *
 * P0-1: `verifiedState` / `verificationScore` are intentionally NOT writable here — see
 * CreateObjectInput.
 */
export interface UpdateObjectInput {
  properties?: Record<string, unknown>;
  expectedState?: string | null;
  claimedState?: string | null;
}

/** Filter for listing objects. Soft-deleted (archived) objects are excluded by default. */
export interface ObjectQuery {
  type?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface CreateLinkInput {
  fromObject: string;
  toObject: string;
  relation: string;
}

/** Realtime object-change notification streamed over SSE (GET /objects/stream). */
export type ObjectChangeKind = 'created' | 'updated' | 'archived' | 'verified';

export interface ObjectChangeEvent {
  kind: ObjectChangeKind;
  tenantId: string;
  objectId: string;
  type: string;
  /** ISO-8601 timestamp. */
  at: string;
}

/** One append-only event row for an object's timeline (GET /objects/:id/timeline). */
export interface TimelineEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  actor?: string | null;
  at: string;
}

/** One verification_ledger row for an object's timeline (the truth accruing over time). */
export interface TimelineLedgerRow {
  id: string;
  verifiedState: string;
  verificationScore: number;
  evidence: Array<{ kind?: string; ref?: string; note?: string }>;
  reason?: string | null;
  at: string;
}

/**
 * P3 drill-down: the full story for one object — its current state + the append-only events and
 * verification-ledger rows about it (e.g. the Room-3 conflict → verified narrative). Tenant-scoped.
 */
export interface ObjectTimeline {
  object: {
    id: string;
    type: string;
    properties: Record<string, unknown>;
    expectedState: string | null;
    claimedState: string | null;
    verifiedState: string | null;
    verificationScore: number | null;
  } | null;
  events: TimelineEvent[];
  ledger: TimelineLedgerRow[];
}

/**
 * T2 · scan-to-locate. The read-only resolution of a scanned QR/barcode payload to ONE object in the
 * caller's tenant (GET /objects/resolve?code=). Tenant-scoped by RLS — a code that belongs to another
 * tenant resolves to nothing. This never mutates anything; it only helps the terminal attach a report
 * / evidence to the correct existing object.
 */
export interface ScanResolveResult {
  objectId: string;
  type: string;
  /** Human label (properties.label / name / taskType, else the type). */
  label: string;
  verifiedState: string | null;
  verificationScore: number | null;
}

/**
 * T5 · "My tasks". A read-only projection of ONE Task assigned to the current staff (GET /tasks/mine).
 * Tenant-scoped by RLS + filtered to the caller's own assignedTo links. The verdict is ONLY the
 * Task's verified_state (S2, deterministic) — never derived from LLM/heuristics; null ⇒ unverified.
 */
export interface MyTaskSummary {
  taskId: string;
  taskType: string | null;
  /** Human label: task label → linked Room label → taskType → 'Task'. */
  label: string;
  roomLabel: string | null;
  expectedState: string | null;
  claimedState: string | null;
  /** The ONLY verdict source (deterministic S2). null ⇒ treat as unverified; never defaulted to verified. */
  verifiedState: string | null;
  verificationScore: number | null;
  dueBy: string | null;
  updatedAt: string;
  /**
   * Flow lifecycle as the employee sees it: `pending` (open — awaiting a manager decision, possibly
   * after a rejection) or `closed` (the manager APPROVED it; terminal). verifiedState is S2 reference
   * data and is NOT the flow state — only a manager's explicit APPROVE closes the flow.
   */
  flowState: TaskFlowState | null;
  /**
   * If the manager REJECTED this task in its current open flow, the structured reason + optional
   * detail the employee must see before resubmitting. Null when never rejected (or after a fresh
   * approve/creation). Persisted from the append-only rejection event.
   */
  rejection: TaskRejection | null;
}
