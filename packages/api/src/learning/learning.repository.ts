import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { LearningAuditRecord, LearningChange, LearningFeedbackRecord, LearningRunResult } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import { getSopConfig } from '../verification/sop-config';
import { computeAdjustments, type CurrentResolvers, type LearnFeedback } from './learning.logic';
import { readDomainPenalties } from './learning.sql';

interface ParamRow {
  param_type: 'task' | 'domain_priority';
  param_key: string;
  value: { weights?: Record<string, number>; threshold?: number; base?: number; penalty?: number };
}

function defaultWeight(taskType: string, kind: string): number {
  const w = getSopConfig(taskType).evidenceWeights?.[kind];
  return typeof w === 'number' ? w : 1;
}

@Injectable()
export class LearningRepository {
  /**
   * Deterministic learn run (per tenant, repeatable): read all feedback + current params, compute
   * BOUNDED changes, upsert learning_params, and append one learning_audit row per field changed.
   * Re-running converges (each run steps ≤ config.step toward a target derived from the aggregate).
   */
  async run(tenantId: string): Promise<LearningRunResult> {
    return withTenant(tenantId, async (c) => {
      const fbRes = await c.query<{ kind: LearnFeedback['kind']; domain: string | null; task_type: string | null; to_state: string | null; evidence_kinds: string[] | null }>(
        `SELECT kind, domain, task_type, to_state, evidence_kinds FROM learning_feedback`,
      );
      const feedback: LearnFeedback[] = fbRes.rows.map((r) => ({
        kind: r.kind,
        domain: r.domain,
        taskType: r.task_type,
        toState: r.to_state,
        evidenceKinds: r.evidence_kinds ?? [],
      }));

      const paramsRes = await c.query<ParamRow>(`SELECT param_type, param_key, value FROM learning_params`);
      const taskVal = new Map<string, ParamRow['value']>();
      const penaltyVal = new Map<string, number>();
      for (const row of paramsRes.rows) {
        if (row.param_type === 'task') taskVal.set(row.param_key, row.value ?? {});
        else if (row.param_type === 'domain_priority') penaltyVal.set(row.param_key, typeof row.value?.penalty === 'number' ? row.value.penalty : 0);
      }

      const current: CurrentResolvers = {
        weight: (t, k) => taskVal.get(t)?.weights?.[k] ?? defaultWeight(t, k),
        threshold: (t) => taskVal.get(t)?.threshold ?? getSopConfig(t).confidenceThreshold,
        penalty: (d) => penaltyVal.get(d) ?? 0,
      };

      const changes = computeAdjustments(feedback, current);
      const runId = randomUUID();

      // Group changes per (param_type, param_key): merge fields into one value, upsert once, audit each.
      const grouped = new Map<string, LearningChange[]>();
      for (const ch of changes) {
        const key = `${ch.paramType}|${ch.paramKey}`;
        const list = grouped.get(key) ?? [];
        list.push(ch);
        grouped.set(key, list);
      }

      for (const [key, chs] of grouped) {
        const [ptype, pkey] = key.split('|') as ['task' | 'domain_priority', string];
        let value: ParamRow['value'];
        if (ptype === 'task') {
          const existing = taskVal.get(pkey) ?? {};
          const merged: ParamRow['value'] = { ...existing, weights: { ...(existing.weights ?? {}) } };
          for (const ch of chs) {
            if (ch.field.startsWith('weights.')) merged.weights![ch.field.slice('weights.'.length)] = ch.after;
            else if (ch.field === 'threshold') merged.threshold = ch.after;
            else if (ch.field === 'base') merged.base = ch.after;
          }
          value = merged;
        } else {
          value = { penalty: chs.find((ch) => ch.field === 'penalty')?.after ?? penaltyVal.get(pkey) ?? 0 };
        }
        await c.query(
          `INSERT INTO learning_params (tenant_id, param_type, param_key, value, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (tenant_id, param_type, param_key) DO UPDATE SET value = $4::jsonb, updated_at = now()`,
          [tenantId, ptype, pkey, JSON.stringify(value)],
        );
        for (const ch of chs) {
          await c.query(
            `INSERT INTO learning_audit (tenant_id, run_id, param_type, param_key, field, before, after, basis, kind)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, 'adjust')`,
            [tenantId, runId, ch.paramType, ch.paramKey, ch.field, JSON.stringify(ch.before), JSON.stringify(ch.after), JSON.stringify(ch.basis)],
          );
        }
      }

      return { runId, feedbackConsidered: feedback.length, changes };
    });
  }

  /** Revert the most recent adjust run: restore each field's `before`, append rollback audit rows. */
  async rollback(tenantId: string): Promise<{ runId: string | null; reverted: number }> {
    return withTenant(tenantId, async (c) => {
      const last = await c.query<{ run_id: string }>(
        `SELECT run_id FROM learning_audit WHERE kind = 'adjust' ORDER BY created_at DESC LIMIT 1`,
      );
      const targetRun = last.rows[0]?.run_id;
      if (!targetRun) return { runId: null, reverted: 0 };

      const rows = await c.query<{ param_type: 'task' | 'domain_priority'; param_key: string; field: string; before: number | null; after: number | null }>(
        `SELECT param_type, param_key, field, before, after FROM learning_audit WHERE run_id = $1 AND kind = 'adjust' ORDER BY created_at ASC`,
        [targetRun],
      );
      const grouped = new Map<string, typeof rows.rows>();
      for (const r of rows.rows) {
        const key = `${r.param_type}|${r.param_key}`;
        const list = grouped.get(key) ?? [];
        list.push(r);
        grouped.set(key, list);
      }

      const rollbackRun = randomUUID();
      let reverted = 0;
      for (const [key, rws] of grouped) {
        const [ptype, pkey] = key.split('|') as ['task' | 'domain_priority', string];
        const curRes = await c.query<{ value: ParamRow['value'] }>(
          `SELECT value FROM learning_params WHERE param_type = $1 AND param_key = $2`,
          [ptype, pkey],
        );
        const value: ParamRow['value'] = { ...(curRes.rows[0]?.value ?? {}), weights: { ...(curRes.rows[0]?.value?.weights ?? {}) } };
        for (const r of rws) {
          if (ptype === 'task') {
            if (r.field.startsWith('weights.')) {
              const k = r.field.slice('weights.'.length);
              if (r.before == null) delete value.weights![k];
              else value.weights![k] = r.before;
            } else if (r.field === 'threshold') {
              if (r.before == null) delete value.threshold;
              else value.threshold = r.before;
            }
          } else {
            value.penalty = r.before ?? 0;
          }
          await c.query(
            `INSERT INTO learning_audit (tenant_id, run_id, param_type, param_key, field, before, after, basis, kind)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, 'rollback')`,
            [tenantId, rollbackRun, ptype, pkey, r.field, JSON.stringify(r.after), JSON.stringify(r.before), JSON.stringify({ rollbackOf: targetRun })],
          );
          reverted += 1;
        }
        await c.query(
          `INSERT INTO learning_params (tenant_id, param_type, param_key, value, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (tenant_id, param_type, param_key) DO UPDATE SET value = $4::jsonb, updated_at = now()`,
          [tenantId, ptype, pkey, JSON.stringify(value)],
        );
      }
      return { runId: rollbackRun, reverted };
    });
  }

  /** S3 read-back: domain → priority penalty for this tenant. */
  getDomainPriorityPenalties(tenantId: string): Promise<Record<string, number>> {
    return withTenant(tenantId, (c) => readDomainPenalties(c));
  }

  async listFeedback(tenantId: string, limit = 200): Promise<LearningFeedbackRecord[]> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{
        id: string; kind: LearningFeedbackRecord['kind']; domain: string | null; action_type: string | null; task_type: string | null;
        object_id: string | null; recommendation_id: string | null; from_state: string | null; to_state: string | null;
        evidence_kinds: string[] | null; created_at: string;
      }>(
        `SELECT id, kind, domain, action_type, task_type, object_id, recommendation_id, from_state, to_state, evidence_kinds, created_at
           FROM learning_feedback ORDER BY created_at DESC LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return res.rows.map((r) => ({
        id: r.id, kind: r.kind, domain: r.domain, actionType: r.action_type, taskType: r.task_type,
        objectId: r.object_id, recommendationId: r.recommendation_id, fromState: r.from_state, toState: r.to_state,
        evidenceKinds: r.evidence_kinds ?? [], at: new Date(r.created_at).toISOString(),
      }));
    });
  }

  async listAudit(tenantId: string, limit = 200): Promise<LearningAuditRecord[]> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{
        id: string; run_id: string; param_type: string; param_key: string; field: string;
        before: unknown; after: unknown; basis: Record<string, unknown>; kind: LearningAuditRecord['kind']; created_at: string;
      }>(
        `SELECT id, run_id, param_type, param_key, field, before, after, basis, kind, created_at
           FROM learning_audit ORDER BY created_at DESC LIMIT $1`,
        [Math.min(Math.max(limit, 1), 500)],
      );
      return res.rows.map((r) => ({
        id: r.id, runId: r.run_id, paramType: r.param_type, paramKey: r.param_key, field: r.field,
        before: r.before, after: r.after, basis: r.basis ?? {}, kind: r.kind, at: new Date(r.created_at).toISOString(),
      }));
    });
  }
}
