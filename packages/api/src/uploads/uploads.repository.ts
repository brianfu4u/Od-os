import { Injectable } from '@nestjs/common';
import type { EvidenceKind } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

@Injectable()
export class UploadsRepository {
  /** Creates a Snapshot/Document evidence object (+ event, + optional evidence→subject link). */
  async createEvidence(
    tenantId: string,
    params: { kind: EvidenceKind; properties: Record<string, unknown>; linkTo?: string },
  ): Promise<{ id: string }> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [tenantId, params.kind, JSON.stringify(params.properties)],
      );
      const id = res.rows[0]!.id;
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'object.created', $3::jsonb, 'uploads')`,
        [tenantId, id, JSON.stringify({ type: params.kind })],
      );
      if (params.linkTo) {
        const exists = await c.query(`SELECT 1 FROM objects WHERE id = $1`, [params.linkTo]);
        if (exists.rows[0]) {
          // evidence —references→ subject (matches the seed's Snapshot→Task pattern)
          await c.query(
            `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, 'references') ON CONFLICT DO NOTHING`,
            [tenantId, id, params.linkTo],
          );
        }
      }
      return { id };
    });
  }

  /** Tenant-scoped lookup of an evidence object's storage metadata (for streaming content). */
  async getStoredMeta(
    tenantId: string,
    id: string,
  ): Promise<{ storageRef: string; mimeType: string; filename: string } | null> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ properties: Record<string, unknown> }>(
        `SELECT properties FROM objects WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row || typeof row.properties.storageRef !== 'string') return null;
      const p = row.properties;
      return {
        storageRef: p.storageRef as string,
        mimeType: typeof p.mimeType === 'string' ? p.mimeType : 'application/octet-stream',
        filename: typeof p.filename === 'string' ? p.filename : 'file',
      };
    });
  }
}
