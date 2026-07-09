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
  confidence: string | null;
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

function mapObject(r: ObjectRow): OntologyObject {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    properties: r.properties,
    expectedState: r.expected_state,
    claimedState: r.claimed_state,
    verifiedState: r.verified_state,
    confidence: r.confidence === null ? null : Number(r.confidence),
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
      const res = await c.query<ObjectRow>(
        `INSERT INTO objects (tenant_id, type, properties, expected_state, claimed_state, verified_state, confidence)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
         RETURNING *`,
        [
          tenantId,
          input.type,
          JSON.stringify(input.properties ?? {}),
          input.expectedState ?? null,
          input.claimedState ?? null,
          input.verifiedState ?? null,
          input.confidence ?? null,
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

      const res = await c.query<ObjectRow>(
        `UPDATE objects
           SET properties = $2::jsonb, expected_state = $3, claimed_state = $4, verified_state = $5, confidence = $6
         WHERE id = $1
         RETURNING *`,
        [
          id,
          JSON.stringify(mergedProps),
          input.expectedState !== undefined ? input.expectedState : existing.expected_state,
          input.claimedState !== undefined ? input.claimedState : existing.claimed_state,
          input.verifiedState !== undefined ? input.verifiedState : existing.verified_state,
          input.confidence !== undefined
            ? input.confidence
            : existing.confidence === null
              ? null
              : Number(existing.confidence),
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
            confidence: o.confidence === null ? null : Number(o.confidence),
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

      const ldRes = await c.query<{ id: string; verified_state: string; confidence: string; evidence: unknown; reason: string | null; created_at: string }>(
        `SELECT id, verified_state, confidence, evidence, reason, created_at FROM verification_ledger WHERE object_id = $1 ORDER BY created_at ASC`,
        [id],
      );
      const ledger = ldRes.rows.map((r) => ({
        id: r.id,
        verifiedState: r.verified_state,
        confidence: Number(r.confidence),
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
