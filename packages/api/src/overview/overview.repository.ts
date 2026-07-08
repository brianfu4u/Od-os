import { Injectable } from '@nestjs/common';
import type { CommSummary, LedgerEntrySummary, OverviewResult } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

@Injectable()
export class OverviewRepository {
  /** One tenant-scoped read assembling everything the command-center chrome needs. */
  async overview(tenantId: string): Promise<OverviewResult> {
    return withTenant(tenantId, async (c) => {
      const countsRes = await c.query<{ type: string; n: number }>(
        `SELECT type, count(*)::int AS n FROM objects GROUP BY type`,
      );
      const counts: Record<string, number> = {};
      for (const r of countsRes.rows) counts[r.type] = r.n;

      const conflicts = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM objects WHERE verified_state = 'conflict'`);
      const overdue = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM objects WHERE type='Task' AND (properties->>'dueBy') < now()::text AND verified_state IS DISTINCT FROM 'verified'`,
      );
      const openRecs = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM objects WHERE type='Recommendation' AND properties->>'status'='open'`);
      const invLow = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM objects
          WHERE type='InventoryItem' AND (properties->>'onHand') IS NOT NULL AND (properties->>'reorderPoint') IS NOT NULL
            AND (properties->>'onHand')::numeric <= (properties->>'reorderPoint')::numeric`,
      );

      const openConflicts = conflicts.rows[0]!.n;
      const overdueN = overdue.rows[0]!.n;
      const score = Math.max(0, Math.min(100, 100 - openConflicts * 15 - overdueN * 10));

      const ledgerRes = await c.query<{
        object_id: string;
        verified_state: string;
        confidence: string;
        evidence: unknown;
        created_at: string;
        properties: Record<string, unknown>;
      }>(
        `SELECT vl.object_id, vl.verified_state, vl.confidence, vl.evidence, vl.created_at, o.properties
           FROM verification_ledger vl JOIN objects o ON o.id = vl.object_id
          ORDER BY vl.created_at DESC LIMIT 8`,
      );
      const ledger: LedgerEntrySummary[] = ledgerRes.rows.map((r) => {
        const items = Array.isArray(r.evidence) ? (r.evidence as Array<Record<string, unknown>>) : [];
        const kinds = [...new Set(items.map((e) => String(e.kind ?? e.type ?? 'evidence')))];
        return {
          objectId: r.object_id,
          title: title(r.properties),
          verifiedState: r.verified_state,
          confidence: Number(r.confidence),
          evidenceCount: items.length,
          evidenceKinds: kinds,
          at: new Date(r.created_at).toISOString(),
        };
      });

      const commRes = await c.query<{ id: string; properties: Record<string, unknown>; created_at: string }>(
        `SELECT id, properties, created_at FROM objects WHERE type='Communication' ORDER BY created_at DESC LIMIT 8`,
      );
      const comms: CommSummary[] = commRes.rows.map((r) => ({
        id: r.id,
        // author may be a plain string (seed) or an object {handle,displayName} (S1-2 reports).
        author: authorName(r.properties.author),
        text: typeof r.properties.text === 'string' ? r.properties.text : String(r.properties.reportType ?? ''),
        reportType: typeof r.properties.reportType === 'string' ? r.properties.reportType : undefined,
        at: new Date(r.created_at).toISOString(),
      }));

      return {
        tempo: { score, openConflicts, overdue: overdueN, openRecommendations: openRecs.rows[0]!.n },
        counts,
        inventoryLow: invLow.rows[0]!.n,
        ledger,
        comms,
      };
    });
  }
}

function title(p: Record<string, unknown>): string {
  return (typeof p.label === 'string' && p.label) || (typeof p.taskType === 'string' && p.taskType) || 'object';
}

function authorName(a: unknown): string {
  if (typeof a === 'string' && a) return a;
  if (a && typeof a === 'object') {
    const o = a as Record<string, unknown>;
    if (typeof o.displayName === 'string' && o.displayName) return o.displayName;
    if (typeof o.handle === 'string' && o.handle) return o.handle;
  }
  return 'staff';
}
