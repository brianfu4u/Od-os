import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { StaffReportInput, StaffReportResult } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

interface IdRow {
  id: string;
}

/**
 * Ingests a staff report as a Communication in a SINGLE tenant-scoped transaction:
 * idempotency check → find/provision Staff → insert Communication → events-on-change →
 * references links (author Staff + any resolved scan targets). All via withTenant() so
 * RLS is the isolation boundary and the whole report lands atomically.
 */
@Injectable()
export class ReportsRepository {
  async ingest(tenantId: string, input: StaffReportInput): Promise<StaffReportResult> {
    return withTenant(tenantId, async (c) => {
      // 1) Idempotency: same clientMessageId → return the existing Communication.
      const dupe = await this.findByClientMessageId(c, input.clientMessageId);
      if (dupe) {
        return { ...dupe, deduped: true };
      }

      // 2) Resolve or provision the author Staff by handle (dev: staffHandle; prod: session).
      const handle = input.staffHandle ?? 'unknown';
      const staffId = await this.findOrProvisionStaff(c, tenantId, handle, input.staffDisplayName);

      // 3) Create the Communication object.
      const now = new Date().toISOString();
      const properties = {
        channel: 'wx_miniprogram',
        reportType: input.reportType,
        text: input.text ?? null,
        fields: input.fields ?? {},
        attachments: input.attachments ?? [],
        scans: input.scans ?? [],
        clientMessageId: input.clientMessageId,
        authorStaffId: staffId,
        author: { staffId, handle, displayName: input.staffDisplayName ?? handle },
        at: input.at ?? now,
        receivedAt: now,
      };

      let communicationId: string;
      try {
        const inserted = await c.query<IdRow>(
          `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Communication', $2::jsonb) RETURNING id`,
          [tenantId, JSON.stringify(properties)],
        );
        communicationId = inserted.rows[0]!.id;
      } catch (err) {
        // Concurrent duplicate raced past the check → the unique index caught it.
        if ((err as { code?: string }).code === '23505') {
          const again = await this.findByClientMessageId(c, input.clientMessageId);
          if (again) return { ...again, deduped: true };
        }
        throw err;
      }

      // 4) Events-on-change: a semantic report event alongside the object.created write.
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'object.created', $3::jsonb, 'reports')`,
        [tenantId, communicationId, JSON.stringify({ type: 'Communication' })],
      );
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'report.received', $3::jsonb, $4)`,
        [
          tenantId,
          communicationId,
          JSON.stringify({
            reportType: input.reportType,
            clientMessageId: input.clientMessageId,
            attachments: (input.attachments ?? []).length,
            scans: (input.scans ?? []).length,
          }),
          handle,
        ],
      );

      // 5) Author link: Communication —references→ Staff.
      await this.link(c, tenantId, communicationId, staffId);

      // 6) Scan evidence: Communication —references→ each resolved, same-tenant scan target.
      for (const scan of input.scans ?? []) {
        if (scan.scannedObjectId) {
          const exists = await c.query(`SELECT 1 FROM objects WHERE id = $1`, [scan.scannedObjectId]);
          if (exists.rows[0]) {
            await this.link(c, tenantId, communicationId, scan.scannedObjectId);
          }
        }
      }

      // 7) Attachment evidence (upload-first S1-3): link resolved uploaded objects + mark attached.
      for (const att of input.attachments ?? []) {
        if (att.objectId) {
          const exists = await c.query(`SELECT 1 FROM objects WHERE id = $1`, [att.objectId]);
          if (exists.rows[0]) {
            await this.link(c, tenantId, communicationId, att.objectId);
            await c.query(
              `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'evidence.attached', $3::jsonb, 'reports')`,
              [tenantId, att.objectId, JSON.stringify({ communicationId })],
            );
          }
        }
      }

      return { communicationId, staffId, deduped: false };
    });
  }

  private async findByClientMessageId(
    c: PoolClient,
    clientMessageId: string,
  ): Promise<{ communicationId: string; staffId: string } | null> {
    const res = await c.query<{ id: string; author_staff_id: string | null }>(
      `SELECT id, properties->>'authorStaffId' AS author_staff_id
         FROM objects
        WHERE type = 'Communication' AND properties->>'clientMessageId' = $1
        LIMIT 1`,
      [clientMessageId],
    );
    const row = res.rows[0];
    return row ? { communicationId: row.id, staffId: row.author_staff_id ?? '' } : null;
  }

  private async findOrProvisionStaff(
    c: PoolClient,
    tenantId: string,
    handle: string,
    displayName: string | undefined,
  ): Promise<string> {
    const found = await c.query<IdRow>(
      `SELECT id FROM objects WHERE type = 'Staff' AND properties->>'staffHandle' = $1 LIMIT 1`,
      [handle],
    );
    if (found.rows[0]) return found.rows[0].id;

    const created = await c.query<IdRow>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Staff', $2::jsonb) RETURNING id`,
      [tenantId, JSON.stringify({ staffHandle: handle, displayName: displayName ?? handle, provisional: true })],
    );
    const staffId = created.rows[0]!.id;
    await c.query(
      `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'object.created', $3::jsonb, 'reports')`,
      [tenantId, staffId, JSON.stringify({ type: 'Staff', provisional: true })],
    );
    return staffId;
  }

  private async link(
    c: PoolClient,
    tenantId: string,
    fromObject: string,
    toObject: string,
  ): Promise<void> {
    await c.query(
      `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, 'references') ON CONFLICT DO NOTHING`,
      [tenantId, fromObject, toObject],
    );
  }
}
