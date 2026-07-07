import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { EvidenceKind } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

export interface EvidenceRecord {
  objectId: string;
  objectType: EvidenceKind;
  kind: string;
  mime: string;
  size: number;
  storageKey: string;
  originalName: string;
  sha256: string;
}

@Injectable()
export class UploadsRepository {
  /** Dedup lookup: an existing Snapshot/Document with identical content in this tenant. */
  async findBySha256(tenantId: string, sha256: string): Promise<EvidenceRecord | null> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string; type: string; properties: Record<string, unknown> }>(
        `SELECT id, type, properties FROM objects
          WHERE type IN ('Snapshot', 'Document') AND properties->>'sha256' = $1
          LIMIT 1`,
        [sha256],
      );
      const row = res.rows[0];
      return row ? toRecord(row.id, row.type, row.properties) : null;
    });
  }

  /** Creates the evidence object (+ object.created; + optional references link, link.created, evidence.attached). */
  async createEvidence(
    tenantId: string,
    params: { objectType: EvidenceKind; properties: Record<string, unknown>; linkTo?: string; relation?: string },
  ): Promise<{ id: string }> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [tenantId, params.objectType, JSON.stringify(params.properties)],
      );
      const id = res.rows[0]!.id;
      await this.event(c, tenantId, id, 'object.created', { type: params.objectType });

      if (params.linkTo) {
        const exists = await c.query(`SELECT 1 FROM objects WHERE id = $1`, [params.linkTo]);
        if (exists.rows[0]) {
          const relation = params.relation ?? 'references';
          await c.query(
            `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [tenantId, id, params.linkTo, relation],
          );
          await this.event(c, tenantId, id, 'link.created', { to: params.linkTo, relation });
          await this.event(c, tenantId, params.linkTo, 'evidence.attached', { evidenceId: id });
        }
      }
      return { id };
    });
  }

  /** Tenant-scoped (RLS) lookup of an object's storage metadata, for minting a signed URL. */
  async getStoredMeta(tenantId: string, id: string): Promise<{ storageKey: string; mime: string } | null> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ properties: Record<string, unknown> }>(
        `SELECT properties FROM objects WHERE id = $1`,
        [id],
      );
      const p = res.rows[0]?.properties;
      if (!p || typeof p.storageKey !== 'string') return null;
      return { storageKey: p.storageKey, mime: typeof p.mime === 'string' ? p.mime : 'application/octet-stream' };
    });
  }

  private async event(
    c: PoolClient,
    tenantId: string,
    objectId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await c.query(
      `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, 'uploads')`,
      [tenantId, objectId, type, JSON.stringify(payload)],
    );
  }
}

function toRecord(id: string, type: string, p: Record<string, unknown>): EvidenceRecord {
  return {
    objectId: id,
    objectType: type as EvidenceKind,
    kind: String(p.kind ?? 'document'),
    mime: String(p.mime ?? 'application/octet-stream'),
    size: typeof p.size === 'number' ? p.size : Number(p.size ?? 0),
    storageKey: String(p.storageKey ?? ''),
    originalName: String(p.originalName ?? 'file'),
    sha256: String(p.sha256 ?? ''),
  };
}
