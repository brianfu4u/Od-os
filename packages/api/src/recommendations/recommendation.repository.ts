import { Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  ActionLogRecord,
  LearningFeedbackKind,
  OperatingTempo,
  ProposedAction,
  RankedRecommendation,
  RecommendationRecord,
  RecommendationStatus,
} from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import { ActionExecutor } from '../actions/action-executor';
import type { ExecutionOutcome } from '../actions/actions.types';
import { insertLearningFeedback } from '../learning/learning.sql';
import type { AgentContext } from './agents';

/** Result of acting on an approval: the updated record + what the write-back did. */
export interface ApprovalResult {
  record: RecommendationRecord | null;
  outcome: ExecutionOutcome | null;
  deduped: boolean;
}

interface ObjRow {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  verified_state: string | null;
  claimed_state: string | null;
  confidence: string | null;
}

@Injectable()
export class RecommendationRepository {
  // The action write-back layer (P2/S4). Optional + default-constructed so hand-wired tests
  // (`new RecommendationRepository()`) keep working without wiring the executor.
  constructor(@Optional() private readonly executor: ActionExecutor = new ActionExecutor()) {}

  /** Build the agent context for an object: the object + its latest Alert. */
  async gatherContext(tenantId: string, objectId: string): Promise<AgentContext | null> {
    return withTenant(tenantId, async (c) => {
      const objRes = await c.query<ObjRow>(
        `SELECT id, type, properties, verified_state, claimed_state, confidence FROM objects WHERE id = $1`,
        [objectId],
      );
      const o = objRes.rows[0];
      if (!o) return null;

      const alertRes = await c.query<{ id: string; properties: Record<string, unknown> }>(
        `SELECT id, properties FROM objects
          WHERE type = 'Alert' AND properties->>'objectId' = $1
          ORDER BY created_at DESC LIMIT 1`,
        [objectId],
      );
      const a = alertRes.rows[0];
      const alert = a
        ? {
            id: a.id,
            triggered: Array.isArray(a.properties.triggered) ? (a.properties.triggered as string[]) : [],
            severity: typeof a.properties.severity === 'string' ? a.properties.severity : 'medium',
            reason: typeof a.properties.reason === 'string' ? a.properties.reason : '',
          }
        : null;

      // Resubmission escalation (closed-loop step 6): the latest `task.resubmission.escalated` marker
      // (if any) is what tips this task into a manager cue. Read-through only.
      const resubmissionEscalation = await this.readResubmissionEscalation(c, objectId);

      return {
        object: {
          id: o.id,
          type: o.type,
          properties: o.properties ?? {},
          verifiedState: o.verified_state,
          claimedState: o.claimed_state,
          confidence: o.confidence === null ? null : Number(o.confidence),
        },
        alert,
        resubmissionEscalation,
        now: Date.now(),
      };
    });
  }

  /** Latest resubmission-escalation marker for an object → the agent's escalation signal (or undefined). */
  private async readResubmissionEscalation(
    c: PoolClient,
    objectId: string,
  ): Promise<AgentContext['resubmissionEscalation']> {
    const res = await c.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.escalated'
        ORDER BY created_at DESC LIMIT 1`,
      [objectId],
    );
    const p = res.rows[0]?.payload;
    if (!p) return undefined;
    return {
      firstReason: typeof p.firstReason === 'string' ? p.firstReason : null,
      latestReason: typeof p.latestReason === 'string' ? p.latestReason : null,
      requiredMissing: Array.isArray(p.requiredMissing) ? p.requiredMissing.filter((k): k is string => typeof k === 'string') : [],
      resubmissionCount: typeof p.resubmissionCount === 'number' ? p.resubmissionCount : 0,
    };
  }

  /**
   * Build agent contexts for EVERY candidate object in the tenant — the driver for the periodic
   * recommendation sweep. The time-based domains (financial/marketing/equipment) don't wait on a
   * verification event, so the sweep scans them directly. One tenant tx: candidate objects +
   * latest Alert per object + an equipment "used-in-place" signal from QR-scan communications.
   */
  async gatherSweepContexts(tenantId: string): Promise<AgentContext[]> {
    return withTenant(tenantId, async (c) => {
      const CANDIDATE_TYPES = ['Task', 'InventoryItem', 'Invoice', 'Payment', 'Claim', 'Review', 'Lead', 'Campaign', 'Equipment'];
      const objs = await c.query<ObjRow>(
        `SELECT id, type, properties, verified_state, claimed_state, confidence
           FROM objects
          WHERE type = ANY($1) AND (properties->>'archived') IS DISTINCT FROM 'true'`,
        [CANDIDATE_TYPES],
      );

      // Latest Alert per subject object (mirrors gatherContext, batched for the whole tenant).
      const alertRows = await c.query<{ id: string; properties: Record<string, unknown> }>(
        `SELECT id, properties FROM objects WHERE type = 'Alert' ORDER BY created_at DESC`,
      );
      const latestAlert = new Map<string, { id: string; triggered: string[]; severity: string; reason: string }>();
      for (const a of alertRows.rows) {
        const oid = typeof a.properties?.objectId === 'string' ? (a.properties.objectId as string) : null;
        if (!oid || latestAlert.has(oid)) continue;
        latestAlert.set(oid, {
          id: a.id,
          triggered: Array.isArray(a.properties.triggered) ? (a.properties.triggered as string[]) : [],
          severity: typeof a.properties.severity === 'string' ? a.properties.severity : 'medium',
          reason: typeof a.properties.reason === 'string' ? a.properties.reason : '',
        });
      }

      // Equipment used-in-place: any Communication carrying a scan of an Equipment object.
      const commRows = await c.query<{ properties: Record<string, unknown> }>(
        `SELECT properties FROM objects WHERE type = 'Communication'`,
      );
      const scannedEquipment = new Set<string>();
      for (const row of commRows.rows) {
        const scans = Array.isArray(row.properties?.scans) ? (row.properties.scans as Array<Record<string, unknown>>) : [];
        for (const s of scans) {
          if (s?.scannedObjectType === 'Equipment' && typeof s.scannedObjectId === 'string') scannedEquipment.add(s.scannedObjectId);
        }
      }

      // Latest resubmission-escalation marker per object (batched) so escalated tasks surface a
      // manager cue on a full sweep too, not only on the live per-object verification path.
      const escRows = await c.query<{ object_id: string; payload: Record<string, unknown> }>(
        `SELECT DISTINCT ON (object_id) object_id, payload
           FROM events WHERE event_type = 'task.resubmission.escalated'
          ORDER BY object_id, created_at DESC`,
      );
      const latestEscalation = new Map<string, AgentContext['resubmissionEscalation']>();
      for (const r of escRows.rows) {
        const p = r.payload ?? {};
        latestEscalation.set(r.object_id, {
          firstReason: typeof p.firstReason === 'string' ? p.firstReason : null,
          latestReason: typeof p.latestReason === 'string' ? p.latestReason : null,
          requiredMissing: Array.isArray(p.requiredMissing) ? p.requiredMissing.filter((k): k is string => typeof k === 'string') : [],
          resubmissionCount: typeof p.resubmissionCount === 'number' ? p.resubmissionCount : 0,
        });
      }

      const now = Date.now();
      return objs.rows.map((o) => ({
        object: {
          id: o.id,
          type: o.type,
          properties: o.properties ?? {},
          verifiedState: o.verified_state,
          claimedState: o.claimed_state,
          confidence: o.confidence === null ? null : Number(o.confidence),
        },
        alert: latestAlert.get(o.id) ?? null,
        related: o.type === 'Equipment' ? { usageScan: scannedEquipment.has(o.id) } : undefined,
        resubmissionEscalation: latestEscalation.get(o.id),
        now,
      }));
    });
  }

  /** Persist ranked candidates as Recommendation objects (idempotent per open objectId+title). */
  async persist(tenantId: string, ranked: RankedRecommendation[]): Promise<string[]> {
    return withTenant(tenantId, async (c) => {
      const created: string[] = [];
      for (const r of ranked) {
        const dupe = await c.query(
          `SELECT 1 FROM objects WHERE type='Recommendation' AND properties->>'objectId'=$1 AND properties->>'title'=$2 AND properties->>'status'='open' LIMIT 1`,
          [r.objectId, r.title],
        );
        if (dupe.rows[0]) continue;

        const properties = {
          domain: r.domain,
          sourceAgent: r.sourceAgent,
          title: r.title,
          why: r.why,
          evidence: r.evidence,
          confidence: r.confidence,
          actions: r.proposedActions,
          rank: r.rank,
          status: 'open' as RecommendationStatus,
          objectId: r.objectId,
          ...(r.tradeoff ? { tradeoff: r.tradeoff } : {}),
        };
        const insRes = await c.query<{ id: string }>(
          `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Recommendation', $2::jsonb) RETURNING id`,
          [tenantId, JSON.stringify(properties)],
        );
        const id = insRes.rows[0]!.id;
        created.push(id);

        if (r.addresses) {
          await this.link(c, tenantId, id, r.addresses, 'addresses');
        }
        await this.link(c, tenantId, id, r.objectId, 'references');
        await c.query(
          `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'recommendation.created', $3::jsonb, 'orchestrator')`,
          [tenantId, id, JSON.stringify({ domain: r.domain, rank: r.rank, objectId: r.objectId })],
        );
      }
      return created;
    });
  }

  async getFeed(tenantId: string, status: RecommendationStatus, limit: number): Promise<RecommendationRecord[]> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string; properties: Record<string, unknown> }>(
        `SELECT id, properties FROM objects
          WHERE type = 'Recommendation' AND properties->>'status' = $1
          ORDER BY (properties->>'rank')::int ASC NULLS LAST, created_at DESC
          LIMIT $2`,
        [status, Math.min(Math.max(limit, 1), 100)],
      );
      return res.rows.map((row) => toRecord(row.id, row.properties));
    });
  }

  async setStatus(tenantId: string, id: string, status: RecommendationStatus): Promise<RecommendationRecord | null> {
    return withTenant(tenantId, async (c) => {
      const cur = await c.query<{ properties: Record<string, unknown> }>(
        `SELECT properties FROM objects WHERE id = $1 AND type = 'Recommendation'`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) return null;
      const properties = { ...row.properties, status };
      await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(properties)]);
      // dismiss / snooze record intent only — no world action. Approvals go through
      // approveAndExecute() (P2/S4), which may run a whitelisted internal write-back.
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, 'manager')`,
        [tenantId, id, `recommendation.${status}`, JSON.stringify({ status })],
      );
      // P4/S8: dismissed/snoozed are learning signals (a domain repeatedly dismissed → downgraded).
      if (status === 'dismissed' || status === 'snoozed') {
        await this.captureFeedback(c, tenantId, id, properties, `recommendation_${status}` as LearningFeedbackKind);
      }
      return toRecord(id, properties);
    });
  }

  /**
   * P2/S4: approve a recommendation and, if its action is on the low-risk internal write-back
   * whitelist, EXECUTE it — all atomically in one withTenant() tx. `SELECT … FOR UPDATE` locks the
   * recommendation row so concurrent approves serialize; the execution marker on the object makes a
   * repeat approve a no-op (idempotent), and the executor's action_log unique index is the DB backstop.
   */
  async approveAndExecute(tenantId: string, id: string, actor: string): Promise<ApprovalResult> {
    return withTenant(tenantId, async (c) => {
      const cur = await c.query<{ properties: Record<string, unknown> }>(
        `SELECT properties FROM objects WHERE id = $1 AND type = 'Recommendation' FOR UPDATE`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) return { record: null, outcome: null, deduped: false };
      const props = row.properties ?? {};

      // Idempotent: already acted on → never re-execute. Ensure status reflects the approval.
      const existing = props.execution as ExecutionOutcome | undefined;
      if (existing) {
        if (props.status !== 'approved') {
          const p2 = { ...props, status: 'approved' as RecommendationStatus };
          await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(p2)]);
          return { record: toRecord(id, p2), outcome: existing, deduped: true };
        }
        return { record: toRecord(id, props), outcome: existing, deduped: true };
      }

      const actions = Array.isArray(props.actions) ? (props.actions as ProposedAction[]) : [];
      const objectId = String(props.objectId ?? '');
      const outcome = await this.executor.onApprove({ client: c, tenantId, recommendation: { id, objectId, actions }, actor });

      const marker = {
        state: outcome.state,
        ...(outcome.actionType ? { actionType: outcome.actionType } : {}),
        ...(outcome.riskTier ? { riskTier: outcome.riskTier } : {}),
        ...(outcome.actionLogId ? { actionLogId: outcome.actionLogId } : {}),
        ...(outcome.targetObjectId ? { targetObjectId: outcome.targetObjectId } : {}),
        ...(outcome.createdObjectId ? { createdObjectId: outcome.createdObjectId } : {}),
        undoable: outcome.undoable,
        at: new Date().toISOString(),
      };
      const nextProps = { ...props, status: 'approved' as RecommendationStatus, execution: marker };
      await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(nextProps)]);
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'recommendation.approved', $3::jsonb, $4)`,
        [tenantId, id, JSON.stringify({ status: 'approved', execution: outcome.state }), actor],
      );
      await this.captureFeedback(c, tenantId, id, nextProps, 'recommendation_approved');
      return { record: toRecord(id, nextProps), outcome, deduped: false };
    });
  }

  /** P2/S4: reverse the executed write-back for a recommendation (idempotent) and reopen the cue. */
  async undoAction(tenantId: string, id: string, actor: string): Promise<ApprovalResult> {
    return withTenant(tenantId, async (c) => {
      const cur = await c.query<{ properties: Record<string, unknown> }>(
        `SELECT properties FROM objects WHERE id = $1 AND type = 'Recommendation' FOR UPDATE`,
        [id],
      );
      const row = cur.rows[0];
      if (!row) return { record: null, outcome: null, deduped: false };
      const props = row.properties ?? {};
      const objectId = String(props.objectId ?? '');
      const outcome = await this.executor.undo({ client: c, tenantId, recommendation: { id, objectId }, actor });

      // Only mutate the cue when a NEW undo actually happened (actionLogId present).
      if (outcome.state === 'undone' && outcome.actionLogId) {
        const prevExec = (props.execution as Record<string, unknown>) ?? {};
        const nextProps = {
          ...props,
          status: 'open' as RecommendationStatus,
          execution: { ...prevExec, state: 'undone', undoable: false, at: new Date().toISOString() },
        };
        await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(nextProps)]);
        await c.query(
          `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'recommendation.reopened', $3::jsonb, $4)`,
          [tenantId, id, JSON.stringify({ via: 'undo' }), actor],
        );
        await this.captureFeedback(c, tenantId, id, nextProps, 'recommendation_undone');
        return { record: toRecord(id, nextProps), outcome, deduped: false };
      }
      return { record: toRecord(id, props), outcome, deduped: true };
    });
  }

  /** P2/S4: the append-only action_log for a recommendation (what its approval did). */
  async getActionLog(tenantId: string, id: string): Promise<ActionLogRecord[]> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{
        id: string; recommendation_id: string; action_type: string; result: string; risk_tier: string | null;
        actor: string | null; target_object_id: string | null; created_object_id: string | null;
        undoable: boolean; undo_of: string | null; created_at: string;
      }>(
        `SELECT id, recommendation_id, action_type, result, risk_tier, actor, target_object_id,
                created_object_id, undoable, undo_of, created_at
           FROM action_log WHERE recommendation_id = $1 ORDER BY created_at ASC`,
        [id],
      );
      return res.rows.map((r) => ({
        id: r.id,
        recommendationId: r.recommendation_id,
        actionType: r.action_type,
        result: r.result as ActionLogRecord['result'],
        ...(r.risk_tier ? { riskTier: r.risk_tier as ActionLogRecord['riskTier'] } : {}),
        ...(r.actor ? { actor: r.actor } : {}),
        targetObjectId: r.target_object_id,
        createdObjectId: r.created_object_id,
        undoable: r.undoable,
        ...(r.undo_of ? { undoOf: r.undo_of } : {}),
        at: new Date(r.created_at).toISOString(),
      }));
    });
  }

  async operatingTempo(tenantId: string): Promise<OperatingTempo> {
    return withTenant(tenantId, async (c) => {
      const conflicts = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM objects WHERE verified_state = 'conflict'`);
      const overdue = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM objects WHERE type='Task' AND (properties->>'dueBy') < now()::text AND verified_state IS DISTINCT FROM 'verified'`,
      );
      const openRecs = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM objects WHERE type='Recommendation' AND properties->>'status'='open'`);
      const openConflicts = conflicts.rows[0]!.n;
      const overdueN = overdue.rows[0]!.n;
      const score = Math.max(0, Math.min(100, 100 - openConflicts * 15 - overdueN * 10));
      return { score, openConflicts, overdue: overdueN, openRecommendations: openRecs.rows[0]!.n };
    });
  }

  private async link(c: PoolClient, tenantId: string, from: string, to: string, relation: string): Promise<void> {
    await c.query(
      `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenantId, from, to, relation],
    );
  }

  /** P4/S8: capture a recommendation-lifecycle feedback signal (append-only), in the same tx. */
  private async captureFeedback(
    c: PoolClient,
    tenantId: string,
    id: string,
    props: Record<string, unknown>,
    kind: LearningFeedbackKind,
  ): Promise<void> {
    const actions = Array.isArray(props.actions) ? (props.actions as ProposedAction[]) : [];
    await insertLearningFeedback(c, tenantId, {
      kind,
      domain: typeof props.domain === 'string' ? props.domain : null,
      actionType: actions[0]?.actionType ?? null,
      objectId: typeof props.objectId === 'string' ? props.objectId : null,
      recommendationId: id,
    });
  }
}

function toRecord(id: string, p: Record<string, unknown>): RecommendationRecord {
  return {
    id,
    domain: p.domain as RecommendationRecord['domain'],
    sourceAgent: p.sourceAgent as RecommendationRecord['sourceAgent'],
    title: String(p.title ?? ''),
    why: String(p.why ?? ''),
    evidence: Array.isArray(p.evidence) ? (p.evidence as RecommendationRecord['evidence']) : [],
    confidence: typeof p.confidence === 'number' ? p.confidence : Number(p.confidence ?? 0),
    actions: Array.isArray(p.actions) ? (p.actions as RecommendationRecord['actions']) : [],
    rank: typeof p.rank === 'number' ? p.rank : Number(p.rank ?? 0),
    status: (p.status as RecommendationRecord['status']) ?? 'open',
    objectId: String(p.objectId ?? ''),
    ...(typeof p.tradeoff === 'string' ? { tradeoff: p.tradeoff } : {}),
    ...(p.execution && typeof p.execution === 'object'
      ? { execution: p.execution as RecommendationRecord['execution'] }
      : {}),
  };
}
