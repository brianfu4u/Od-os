import type { PoolClient } from 'pg';
import type { ActionResult, ProposedAction, RiskTier } from '@clearview/shared';

/** The subject object a write-back acts on (the cue's `objectId`). */
export interface ActionSubject {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

/**
 * Everything a write-back handler needs, all bound to ONE withTenant() transaction. Handlers MUST
 * use `client` for every query so RLS (not app code) stays the tenant boundary and the whole
 * approval — status change + ontology write + action_log row + event — commits atomically.
 */
export interface ActionContext {
  client: PoolClient;
  tenantId: string;
  recommendationId: string;
  subject: ActionSubject;
  /** Caller-supplied params (e.g. an explicit reassign target); handlers fall back to subject props. */
  params: Record<string, unknown>;
  /** Who approved (manager id / staff id / 'manager') — recorded on the objects/events the action writes. */
  actor: string;
  now: number;
}

/**
 * The planned effect of a write-back — computed WITHOUT writing (any created object id is
 * pre-generated here). Recorded verbatim into the action_log slot BEFORE the side effects run,
 * so claiming the idempotency slot and performing the effect are ordered (claim-first).
 */
export interface WritebackPlan {
  targetObjectId?: string | null;
  createdObjectId?: string | null;
  before: unknown;
  after: unknown;
}

/** The subset of an action_log row that `undo` needs to reverse a prior write-back. */
export interface ExecutedActionRow {
  id: string;
  actionType: string;
  targetObjectId: string | null;
  createdObjectId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * A whitelisted, LOW-RISK, strictly INTERNAL ontology write-back. It may only create/patch objects
 * and links within the tenant — never any external side effect (no messaging, ordering, payment).
 */
export interface ActionHandler {
  /** Canonical actionType; must match the `ProposedAction.actionType` the agents emit. */
  readonly actionType: string;
  /** Whether this action can be reversed via `undo`. */
  readonly undoable: boolean;
  /** Human-readable summary for logs/UI. */
  describe(subject: ActionSubject): string;
  /**
   * Returns a reason string if the action CANNOT run against this subject (e.g. missing target),
   * or null if it can. Checked before planning so we log `not_executable` instead of aborting.
   */
  canExecute(ctx: ActionContext): string | null;
  /**
   * Compute the planned effect WITHOUT writing (pre-generating any created object id). The executor
   * records this into the action_log slot first; only if it wins the slot does it call `apply`.
   */
  plan(ctx: ActionContext): Promise<WritebackPlan>;
  /** Perform the side effects for a previously-`plan`ned write-back (runs only after the slot is won). */
  apply(ctx: ActionContext, plan: WritebackPlan): Promise<void>;
  /** Reverse a previously executed write-back, restoring the recorded before-state. */
  undo(ctx: ActionContext, log: ExecutedActionRow): Promise<void>;
}

/** The gate decision for an approved recommendation, derived purely from its proposed actions. */
export interface ActionDecision {
  kind: 'execute' | 'blocked_high_risk' | 'recorded_intent';
  action?: ProposedAction;
}

/** Outcome of acting on an approval — mirrored onto the Recommendation and returned to the caller. */
export interface ExecutionOutcome {
  state: ActionResult;
  actionType: string | null;
  riskTier: RiskTier | null;
  actionLogId: string | null;
  targetObjectId: string | null;
  createdObjectId: string | null;
  undoable: boolean;
  note?: string;
}
