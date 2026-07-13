/**
 * S1-1 object API contract (the S0-4 read/write shapes the frontend + later
 * tickets build against). Kept in @clearview/shared so api and web share one source.
 */

/** Create a new ontology object. `type` is required; per-type fields go in `properties`. */
export interface CreateObjectInput {
  type: string;
  properties?: Record<string, unknown>;
  expectedState?: string | null;
  claimedState?: string | null;
  verifiedState?: string | null;
  confidence?: number | null;
}

/** Partial update. Any provided state field is set; `properties` are shallow-merged. */
export interface UpdateObjectInput {
  properties?: Record<string, unknown>;
  expectedState?: string | null;
  claimedState?: string | null;
  verifiedState?: string | null;
  confidence?: number | null;
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
  confidence: number;
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
    confidence: number | null;
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
  confidence: number | null;
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
  confidence: number | null;
  dueBy: string | null;
  updatedAt: string;
  /**
   * Resubmission (回退重提) — all four are READ-ONLY projections derived from the append-only
   * `task.resubmission.requested` events + verification ledger. They describe "the deterministic S2
   * engine returned a non-verified verdict that requires the staff to add evidence and resubmit".
   * The engine (S2) still owns verifiedState; these fields never feed back into the verdict.
   */
  /**
   * True when the latest verify was non-verified AND asked THE STAFF to add evidence & resubmit
   * (i.e. still within the staff bounce-back cap). Mutually exclusive with `escalatedToManager`:
   * once a task escalates, the staff has no further action and this flips back to false.
   */
  needsResubmission: boolean;
  /** Evidence kinds still missing on the most recent resubmission request (empty when none). */
  requiredMissing: string[];
  /** How many times this task has been sent back to the STAFF for resubmission (append-only count). */
  resubmissionCount: number;
  /** Human-readable reason from the most recent resubmission request (null when none). */
  lastResubmissionReason: string | null;
  /**
   * True when the task exhausted its staff bounce-backs (MAX_STAFF_RESUBMITS) and is now AWAITING
   * MANAGER REVIEW (a `task.resubmission.escalated` marker exists and the task is still non-verified).
   * The staff must NOT resubmit again — the ball is in the manager's court. Derived, read-only.
   */
  escalatedToManager: boolean;
}
