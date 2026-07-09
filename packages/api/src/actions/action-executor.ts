import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ProposedAction } from '@clearview/shared';
import type { ActionContext, ActionDecision, ExecutedActionRow, ExecutionOutcome } from './actions.types';
import { EXECUTABLE_ACTION_TYPES, getHandler } from './action-registry';
import { emitEvent, loadObject } from './actions.sql';

export interface ApprovalInput {
  client: PoolClient;
  tenantId: string;
  recommendation: { id: string; objectId: string; actions: ProposedAction[] };
  actor: string;
  params?: Record<string, unknown>;
  now?: number;
}

export interface UndoInput {
  client: PoolClient;
  tenantId: string;
  recommendation: { id: string; objectId: string };
  actor: string;
  now?: number;
}

interface LogInsert {
  recommendationId: string;
  actionType: string;
  result: ExecutionOutcome['state'];
  riskTier: 'low' | 'high' | null;
  actor: string;
  targetObjectId: string | null;
  createdObjectId: string | null;
  params: Record<string, unknown>;
  before: unknown;
  after: unknown;
  undoable: boolean;
  undoOf: string | null;
}

/**
 * The action write-back layer (P2 · S4). Turns an APPROVED recommendation into a real — but strictly
 * internal and reversible — ontology change, or, for anything not on the whitelist, into an audited
 * no-op. Every method runs inside the caller's withTenant() transaction (the caller also takes a
 * `SELECT … FOR UPDATE` row lock on the recommendation, which — together with the recommendation's
 * execution marker — makes approval single-flight; the partial unique index on
 * action_log(result='executed') is the race-safe DB backstop). No-arg constructable so hand-wired
 * tests can `new ActionExecutor()`.
 */
@Injectable()
export class ActionExecutor {
  /**
   * PURE gate: decide what an approval should do from the cue's proposed actions.
   *  - execute:           the first whitelisted, non-high-risk action → run its write-back
   *  - blocked_high_risk: no whitelisted action but a high-risk one exists → record, never execute
   *  - recorded_intent:   nothing to auto-execute (a nudge / manual action) → record intent only
   */
  decide(actions: ProposedAction[]): ActionDecision {
    const executable = actions.find((a) => EXECUTABLE_ACTION_TYPES.includes(a.actionType) && a.riskTier !== 'high');
    if (executable) return { kind: 'execute', action: executable };
    const highRisk = actions.find((a) => a.riskTier === 'high');
    if (highRisk) return { kind: 'blocked_high_risk', action: highRisk };
    return { kind: 'recorded_intent', action: actions[0] };
  }

  async onApprove(input: ApprovalInput): Promise<ExecutionOutcome> {
    const { client, tenantId, recommendation, actor, now = Date.now() } = input;
    const decision = this.decide(recommendation.actions);

    // High-risk: NEVER executed. Record the refusal so it is auditable.
    if (decision.kind === 'blocked_high_risk') {
      const a = decision.action!;
      const logId = await this.insertLog(client, tenantId, {
        recommendationId: recommendation.id, actionType: a.actionType, result: 'blocked_high_risk',
        riskTier: 'high', actor, targetObjectId: null, createdObjectId: null, params: {}, before: null, after: null,
        undoable: false, undoOf: null,
      });
      await emitEvent(client, tenantId, recommendation.id, 'action.blocked',
        { actionType: a.actionType, riskTier: 'high', reason: 'high-risk action is not on the auto-execute whitelist' }, actor);
      return { state: 'blocked_high_risk', actionType: a.actionType, riskTier: 'high', actionLogId: logId, targetObjectId: null, createdObjectId: null, undoable: false, note: 'high-risk: recorded, not executed' };
    }

    // Nothing to auto-execute (nudge / manual action): record intent only (the S3 behaviour).
    if (decision.kind === 'recorded_intent') {
      const a = decision.action;
      const logId = await this.insertLog(client, tenantId, {
        recommendationId: recommendation.id, actionType: a?.actionType ?? 'none', result: 'recorded_intent',
        riskTier: a?.riskTier ?? null, actor, targetObjectId: null, createdObjectId: null, params: {}, before: null, after: null,
        undoable: false, undoOf: null,
      });
      await emitEvent(client, tenantId, recommendation.id, 'action.recorded', { actionType: a?.actionType ?? null }, actor);
      return { state: 'recorded_intent', actionType: a?.actionType ?? null, riskTier: a?.riskTier ?? null, actionLogId: logId, targetObjectId: null, createdObjectId: null, undoable: false, note: 'no auto-executable action; intent recorded' };
    }

    // Execute a whitelisted, low-risk, internal write-back.
    const action = decision.action!;
    const handler = getHandler(action.actionType)!;
    const subject = await loadObject(client, recommendation.objectId);
    if (!subject) {
      const logId = await this.insertLog(client, tenantId, {
        recommendationId: recommendation.id, actionType: action.actionType, result: 'not_executable',
        riskTier: action.riskTier, actor, targetObjectId: null, createdObjectId: null, params: input.params ?? {}, before: null, after: null,
        undoable: false, undoOf: null,
      });
      return { state: 'not_executable', actionType: action.actionType, riskTier: action.riskTier, actionLogId: logId, targetObjectId: null, createdObjectId: null, undoable: false, note: 'subject object not found' };
    }

    const ctx: ActionContext = { client, tenantId, recommendationId: recommendation.id, subject, params: input.params ?? {}, actor, now };
    const reason = handler.canExecute(ctx);
    if (reason) {
      const logId = await this.insertLog(client, tenantId, {
        recommendationId: recommendation.id, actionType: action.actionType, result: 'not_executable',
        riskTier: action.riskTier, actor, targetObjectId: subject.id, createdObjectId: null, params: input.params ?? {}, before: null, after: null,
        undoable: false, undoOf: null,
      });
      return { state: 'not_executable', actionType: action.actionType, riskTier: action.riskTier, actionLogId: logId, targetObjectId: subject.id, createdObjectId: null, undoable: false, note: reason };
    }

    // P2.1 claim-first: compute the plan WITHOUT writing, claim the action_log 'executed' slot
    // (ON CONFLICT DO NOTHING), and only APPLY the side effects if we won the slot. Symmetric with
    // undo. A concurrent approve that loses the slot performs NO world write.
    const plan = await handler.plan(ctx);
    const logId = await this.insertLog(client, tenantId, {
      recommendationId: recommendation.id, actionType: action.actionType, result: 'executed',
      riskTier: action.riskTier, actor, targetObjectId: plan.targetObjectId ?? null, createdObjectId: plan.createdObjectId ?? null,
      params: input.params ?? {}, before: plan.before ?? null, after: plan.after ?? null, undoable: handler.undoable, undoOf: null,
    });
    if (!logId) {
      // Lost the idempotency race — the slot is already taken. Do NOT apply any side effect.
      return { state: 'executed', actionType: action.actionType, riskTier: action.riskTier, actionLogId: null, targetObjectId: null, createdObjectId: null, undoable: handler.undoable, note: 'already executed (idempotent)' };
    }
    await handler.apply(ctx, plan);
    await emitEvent(client, tenantId, recommendation.id, 'action.executed',
      { actionType: action.actionType, targetObjectId: plan.targetObjectId ?? null, createdObjectId: plan.createdObjectId ?? null, actionLogId: logId }, actor);
    return { state: 'executed', actionType: action.actionType, riskTier: action.riskTier, actionLogId: logId, targetObjectId: plan.targetObjectId ?? null, createdObjectId: plan.createdObjectId ?? null, undoable: handler.undoable };
  }

  /** Reverse the executed write-back for a recommendation (idempotent; restores the before-state). */
  async undo(input: UndoInput): Promise<ExecutionOutcome> {
    const { client, tenantId, recommendation, actor, now = Date.now() } = input;
    const execRes = await client.query<{
      id: string; action_type: string; target_object_id: string | null; created_object_id: string | null;
      before: Record<string, unknown> | null; after: Record<string, unknown> | null;
    }>(
      `SELECT id, action_type, target_object_id, created_object_id, before, after
         FROM action_log WHERE recommendation_id = $1 AND result = 'executed'
         ORDER BY created_at DESC LIMIT 1`,
      [recommendation.id],
    );
    const execRow = execRes.rows[0];
    if (!execRow) {
      return { state: 'not_executable', actionType: null, riskTier: null, actionLogId: null, targetObjectId: null, createdObjectId: null, undoable: false, note: 'no executed action to undo' };
    }
    const handler = getHandler(execRow.action_type);
    if (!handler || !handler.undoable) {
      return { state: 'not_executable', actionType: execRow.action_type, riskTier: null, actionLogId: null, targetObjectId: execRow.target_object_id, createdObjectId: execRow.created_object_id, undoable: false, note: 'action is not reversible' };
    }

    // Claim the undo slot first (race-safe, idempotent). before/after are swapped for the reversal record.
    const undoId = await this.insertLog(client, tenantId, {
      recommendationId: recommendation.id, actionType: execRow.action_type, result: 'undone', riskTier: null, actor,
      targetObjectId: execRow.target_object_id, createdObjectId: execRow.created_object_id, params: {},
      before: execRow.after ?? null, after: execRow.before ?? null, undoable: false, undoOf: execRow.id,
    });
    if (!undoId) {
      return { state: 'undone', actionType: execRow.action_type, riskTier: null, actionLogId: null, targetObjectId: execRow.target_object_id, createdObjectId: execRow.created_object_id, undoable: false, note: 'already undone (idempotent)' };
    }

    const subject = (await loadObject(client, recommendation.objectId)) ?? { id: recommendation.objectId, type: '', properties: {} };
    const ctx: ActionContext = { client, tenantId, recommendationId: recommendation.id, subject, params: {}, actor, now };
    const log: ExecutedActionRow = {
      id: execRow.id, actionType: execRow.action_type, targetObjectId: execRow.target_object_id,
      createdObjectId: execRow.created_object_id, before: execRow.before, after: execRow.after,
    };
    await handler.undo(ctx, log);
    await emitEvent(client, tenantId, recommendation.id, 'action.undone', { actionType: execRow.action_type, undoOf: execRow.id, actionLogId: undoId }, actor);
    return { state: 'undone', actionType: execRow.action_type, riskTier: null, actionLogId: undoId, targetObjectId: execRow.target_object_id, createdObjectId: execRow.created_object_id, undoable: false };
  }

  private async insertLog(client: PoolClient, tenantId: string, row: LogInsert): Promise<string | null> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO action_log
         (tenant_id, recommendation_id, action_type, result, risk_tier, actor,
          target_object_id, created_object_id, params, before, after, undoable, undo_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        tenantId, row.recommendationId, row.actionType, row.result, row.riskTier, row.actor,
        row.targetObjectId, row.createdObjectId, JSON.stringify(row.params ?? {}),
        row.before === null || row.before === undefined ? null : JSON.stringify(row.before),
        row.after === null || row.after === undefined ? null : JSON.stringify(row.after),
        row.undoable, row.undoOf,
      ],
    );
    return res.rows[0]?.id ?? null;
  }
}
