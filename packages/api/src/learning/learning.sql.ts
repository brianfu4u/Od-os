import type { PoolClient } from 'pg';
import type { LearnedTaskParams, LearningFeedbackKind } from '@clearview/shared';

/**
 * Low-level learning-loop SQL on the caller's withTenant() client — so feedback capture and
 * param read-back stay inside the calling transaction and RLS-scoped to the tenant. Shared by the
 * recommendation + verification repos (feedback capture) and the learner (read-back).
 */

export interface FeedbackInput {
  kind: LearningFeedbackKind;
  domain?: string | null;
  actionType?: string | null;
  taskType?: string | null;
  objectId?: string | null;
  recommendationId?: string | null;
  fromState?: string | null;
  toState?: string | null;
  evidenceKinds?: string[] | null;
  payload?: Record<string, unknown>;
}

/** Append one immutable feedback signal. Best-effort by design — callers wrap their own tx. */
export async function insertLearningFeedback(c: PoolClient, tenantId: string, fb: FeedbackInput): Promise<void> {
  await c.query(
    `INSERT INTO learning_feedback
       (tenant_id, kind, domain, action_type, task_type, object_id, recommendation_id, from_state, to_state, evidence_kinds, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      tenantId,
      fb.kind,
      fb.domain ?? null,
      fb.actionType ?? null,
      fb.taskType ?? null,
      fb.objectId ?? null,
      fb.recommendationId ?? null,
      fb.fromState ?? null,
      fb.toState ?? null,
      fb.evidenceKinds ?? null,
      JSON.stringify(fb.payload ?? {}),
    ],
  );
}

/** Per-tenant learned task overrides (or null). Read by S2 (verify) inside its own tenant tx. */
export async function readLearnedTaskParams(c: PoolClient, taskType: string): Promise<LearnedTaskParams | null> {
  const res = await c.query<{ value: LearnedTaskParams }>(
    `SELECT value FROM learning_params WHERE param_type = 'task' AND param_key = $1`,
    [taskType],
  );
  return res.rows[0]?.value ?? null;
}

/** Per-tenant domain → recommendation priority penalty. Read by S3 (orchestration). */
export async function readDomainPenalties(c: PoolClient): Promise<Record<string, number>> {
  const res = await c.query<{ param_key: string; value: { penalty?: number } }>(
    `SELECT param_key, value FROM learning_params WHERE param_type = 'domain_priority'`,
  );
  const out: Record<string, number> = {};
  for (const row of res.rows) {
    const p = row.value?.penalty;
    if (typeof p === 'number' && Number.isFinite(p)) out[row.param_key] = p;
  }
  return out;
}
