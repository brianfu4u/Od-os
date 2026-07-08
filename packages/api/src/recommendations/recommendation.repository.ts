import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  OperatingTempo,
  RankedRecommendation,
  RecommendationRecord,
  RecommendationStatus,
} from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import type { AgentContext } from './agents';

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
        now: Date.now(),
      };
    });
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
      // Human-in-the-loop: this records intent only; no world action is executed in S3.
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, 'manager')`,
        [tenantId, id, `recommendation.${status}`, JSON.stringify({ status })],
      );
      return toRecord(id, properties);
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
  };
}
