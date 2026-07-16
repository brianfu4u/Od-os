import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  OntologyObject,
  OntologyLink,
  CreateObjectInput,
  UpdateObjectInput,
  ObjectQuery,
  CreateLinkInput,
  ObjectTimeline,
  ScanResolveResult,
} from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

interface ObjectRow {
  id: string;
  tenant_id: string;
  type: string;
  properties: Record<string, unknown>;
  expected_state: string | null;
  claimed_state: string | null;
  verified_state: string | null;
  verification_score: string | null;
  created_at: string;
  updated_at: string;
}

interface LinkRow {
  id: string;
  tenant_id: string;
  from_object: string;
  to_object: string;
  relation: string;
  created_at: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function labelOfProps(type: string, p: Record<string, unknown>): string {
  return (
    (typeof p.label === 'string' && p.label) ||
    (typeof p.name === 'string' && p.name) ||
    (typeof p.taskType === 'string' && p.taskType) ||
    type
  );
}

function mapObject(r: ObjectRow): OntologyObject {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    properties: r.properties,
    expectedState: r.expected_state,
    claimedState: r.claimed_state,
    verifiedState: r.verified_state,
    verificationScore: r.verification_score === null ? null : Number(r.verification_score),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/**
 * Data access for ontology objects. EVERY method runs inside withTenant(), so RLS —
 * not application code — is the tenant boundary, and object mutations write an
 * append-only `events` row in the SAME transaction (atomic audit + loop signal).
 */
@Injectable()
export class ObjectsRepository {
  async create(tenantId: string, input: CreateObjectInput): Promise<OntologyObject> {
    return withTenant(tenantId, async (c) => {
      // P0-1: verified_state/verification_score are NOT set here — they are owned exclusively by S2
      // Verification Service (they default to NULL for a fresh object and only ever move through
      // the verification write path, which is additionally guarded by a DB trigger).
      const res = await c.query<ObjectRow>(
        `INSERT INTO objects (tenant_id, type, properties, expected_state, claimed_state)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING *`,
        [
          tenantId,
          input.type,
          JSON.stringify(input.properties ?? {}),
          input.expectedState ?? null,
          input.claimedState ?? null,
        ],
      );
      const row = res.rows[0]!;
      await this.recordEvent(c, tenantId, row.id, 'object.created', { type: row.type });
      return mapObject(row);
    });
  }

  async get(tenantId: string, id: string): Promise<OntologyObject | null> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<ObjectRow>('SELECT * FROM objects WHERE id = $1', [id]);
      const row = res.rows[0];
      return row ? mapObject(row) : null;
    });
  }

  async list(tenantId: string, query: ObjectQuery): Promise<OntologyObject[]> {
    return withTenant(tenantId, async (c) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.type) {
        params.push(query.type);
        clauses.push(`type = $${params.length}`);
      }
      if (!query.includeArchived) {
        clauses.push(`(properties->>'archived') IS DISTINCT FROM 'true'`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      const offset = Math.max(query.offset ?? 0, 0);
      params.push(limit);
      const limitIdx = params.length;
      params.push(offset);
      const offsetIdx = params.length;
      const res = await c.query<ObjectRow>(
        `SELECT * FROM objects ${where} ORDER BY created_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      );
      return res.rows.map(mapObject);
    });
  }

  /**
   * T2 · resolve a scanned code to ONE object in this tenant (read-only). Tries an explicit object
   * UUID first, then a stable business code (`properties.code`) or label. Runs inside withTenant() so
   * RLS scopes the lookup to the caller's tenant — a code from another tenant resolves to null.
   * Archived objects are excluded. No writes.
   */
  async resolveScan(tenantId: string, code: string): Promise<ScanResolveResult | null> {
    const c0 = code.trim();
    if (!c0) return null;
    return withTenant(tenantId, async (c) => {
      let row: ObjectRow | undefined;
      if (UUID_RE.test(c0)) {
        const byId = await c.query<ObjectRow>(
          `SELECT * FROM objects WHERE id = $1 AND (properties->>'archived') IS DISTINCT FROM 'true' LIMIT 1`,
          [c0],
        );
        row = byId.rows[0];
      }
      if (!row) {
        const byCode = await c.query<ObjectRow>(
          `SELECT * FROM objects
             WHERE (properties->>'code' = $1 OR properties->>'label' = $1)
               AND (properties->>'archived') IS DISTINCT FROM 'true'
             ORDER BY created_at DESC
             LIMIT 1`,
          [c0],
        );
        row = byCode.rows[0];
      }
      if (!row) return null;
      return {
        objectId: row.id,
        type: row.type,
        label: labelOfProps(row.type, row.properties ?? {}),
        verifiedState: row.verified_state,
        verificationScore: row.verification_score === null ? null : Number(row.verification_score),
      };
    });
  }

  async update(
    tenantId: string,
    id: string,
    input: UpdateObjectInput,
  ): Promise<OntologyObject | null> {
    return withTenant(tenantId, async (c) => {
      const cur = await c.query<ObjectRow>('SELECT * FROM objects WHERE id = $1', [id]);
      const existing = cur.rows[0];
      if (!existing) return null;

      const mergedProps = input.properties
        ? { ...existing.properties, ...input.properties }
        : existing.properties;

      // P0-1: this generic update never touches verified_state/verification_score. They remain as
      // the S2 Verification Service last wrote them (owned by verification; DB trigger enforces it).
      const res = await c.query<ObjectRow>(
        `UPDATE objects
           SET properties = $2::jsonb, expected_state = $3, claimed_state = $4
         WHERE id = $1
         RETURNING *`,
        [
          id,
          JSON.stringify(mergedProps),
          input.expectedState !== undefined ? input.expectedState : existing.expected_state,
          input.claimedState !== undefined ? input.claimedState : existing.claimed_state,
        ],
      );
      const row = res.rows[0]!;
      await this.recordEvent(c, tenantId, row.id, 'object.updated', { changed: Object.keys(input) });
      return mapObject(row);
    });
  }

  /**
   * Soft delete: sets a LIFECYCLE flag in properties (archived=true) and emits the
   * reserved `object.archived` event. It deliberately does NOT touch the state triplet —
   * verified_state's domain is VERIFIED_STATES and is owned by cross-verification (S2).
   * We never hard-delete: the append-only events FK protects audited objects, and the
   * verification ledger must keep referring to real objects.
   */
  async softDelete(tenantId: string, id: string): Promise<boolean> {
    return withTenant(tenantId, async (c) => {
      const cur = await c.query<ObjectRow>('SELECT * FROM objects WHERE id = $1', [id]);
      const existing = cur.rows[0];
      if (!existing) return false;
      const props = { ...existing.properties, archived: true, archivedAt: new Date().toISOString() };
      await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(props)]);
      await this.recordEvent(c, tenantId, id, 'object.archived', {});
      return true;
    });
  }

  async createLink(tenantId: string, input: CreateLinkInput): Promise<OntologyLink> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<LinkRow>(
        `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, $4) RETURNING *`,
        [tenantId, input.fromObject, input.toObject, input.relation],
      );
      const r = res.rows[0]!;
      return {
        id: r.id,
        tenantId: r.tenant_id,
        fromObject: r.from_object,
        toObject: r.to_object,
        relation: r.relation,
        createdAt: new Date(r.created_at).toISOString(),
      };
    });
  }

  /**
   * P3 drill-down: one object + its append-only events and verification-ledger rows (the story of
   * how its verified_state accrued). All read inside withTenant(), so RLS scopes it to the tenant.
   */
  async timeline(tenantId: string, id: string): Promise<ObjectTimeline> {
    return withTenant(tenantId, async (c) => {
      const objRes = await c.query<ObjectRow>('SELECT * FROM objects WHERE id = $1', [id]);
      const o = objRes.rows[0];
      const object = o
        ? {
            id: o.id,
            type: o.type,
            properties: o.properties ?? {},
            expectedState: o.expected_state,
            claimedState: o.claimed_state,
            verifiedState: o.verified_state,
            verificationScore: o.verification_score === null ? null : Number(o.verification_score),
          }
        : null;

      const evRes = await c.query<{ id: string; event_type: string; payload: Record<string, unknown>; actor: string | null; created_at: string }>(
        `SELECT id, event_type, payload, actor, created_at FROM events WHERE object_id = $1 ORDER BY created_at ASC`,
        [id],
      );
      const events = evRes.rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        payload: r.payload ?? {},
        actor: r.actor ?? null,
        at: new Date(r.created_at).toISOString(),
      }));

      const ldRes = await c.query<{ id: string; verified_state: string; verification_score: string; evidence: unknown; reason: string | null; created_at: string }>(
        `SELECT id, verified_state, verification_score, evidence, reason, created_at FROM verification_ledger WHERE object_id = $1 ORDER BY created_at ASC`,
        [id],
      );
      const ledger = ldRes.rows.map((r) => ({
        id: r.id,
        verifiedState: r.verified_state,
        verificationScore: Number(r.verification_score),
        evidence: Array.isArray(r.evidence) ? (r.evidence as Array<{ kind?: string; ref?: string; note?: string }>) : [],
        reason: r.reason ?? null,
        at: new Date(r.created_at).toISOString(),
      }));

      return { object, events, ledger };
    });
  }

  private async recordEvent(
    client: PoolClient,
    tenantId: string,
    objectId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [tenantId, objectId, eventType, JSON.stringify(payload), 'api'],
    );
  }
}
