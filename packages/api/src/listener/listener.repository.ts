/**
 * All of LLM1's database access, always inside withTenant() so RLS is the isolation boundary.
 * It NEVER writes verified_state (there is no such method here) — the only state write LLM1 performs
 * goes through ObjectsService.update({claimedState}) in the service. This repo:
 *   - loads the source Communication text to analyze,
 *   - resolves (or creates) the Task a claim is about, deterministically,
 *   - appends to the append-only llm_analysis_log (audit),
 *   - gathers recent analyses for summaries.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { withTenant } from '../database/tenant-context';
import { getSopConfig } from '../verification/sop-config';
import { SensitivePayloadsRepository } from '../retention/sensitive-payloads.repository';
import type { ListenClaim, SummaryInputEvent } from './listener.types';

export interface LoadedComm {
  id: string;
  text: string;
  reportType: string | null;
  fields: Record<string, unknown>;
  hasAttachments: boolean;
  hasScans: boolean;
  locale: string | null;
}

export interface AuditRow {
  communicationId: string | null;
  objectId: string | null;
  listener: string;
  model: string | null;
  promptVersion: string;
  locale: string | null;
  eventType: string | null;
  domain: string | null;
  severity: string | null;
  taskType: string | null;
  claimedState: string | null;
  confidence: number | null;
  appliedAction: string;
  input: string | null;
  output: unknown;
}

@Injectable()
export class LlmListenerRepository {
  constructor(private readonly sensitive: SensitivePayloadsRepository) {}

  loadCommunication(tenantId: string, communicationId: string): Promise<LoadedComm | null> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string; properties: Record<string, unknown> }>(
        `SELECT id, properties FROM objects WHERE id = $1 AND type = 'Communication'`,
        [communicationId],
      );
      const row = res.rows[0];
      if (!row) return null;
      const p = row.properties ?? {};
      return {
        id: row.id,
        text: typeof p.text === 'string' ? p.text : '',
        reportType: typeof p.reportType === 'string' ? p.reportType : null,
        fields: (p.fields && typeof p.fields === 'object' ? p.fields : {}) as Record<string, unknown>,
        hasAttachments: Array.isArray(p.attachments) && p.attachments.length > 0,
        hasScans: Array.isArray(p.scans) && p.scans.length > 0,
        locale: typeof p.locale === 'string' ? p.locale : null,
      };
    });
  }

  /**
   * Deterministically resolve the Task a claim is about. Prefers an explicit objectId, then an OPEN
   * (not-yet-verified) Task of the claimed task type whose linked Room (or own label) matches the
   * locator. If none exists and we have enough to name one, create a fresh Task shell to carry the
   * claim (linked to the Room when present). Returns null when nothing can be resolved.
   */
  resolveTaskForClaim(tenantId: string, claim: ListenClaim, options: { create: boolean }): Promise<{ objectId: string; created: boolean } | null> {
    return withTenant(tenantId, async (c) => {
      // 1) Explicit id wins.
      if (claim.locator.objectId) {
        const ex = await c.query(`SELECT 1 FROM objects WHERE id = $1 AND type = 'Task'`, [claim.locator.objectId]);
        if (ex.rows[0]) return { objectId: claim.locator.objectId, created: false };
      }

      const roomLabel = claim.locator.label ?? (claim.locator.room ? `Room ${claim.locator.room}` : null);
      const roomNeedle = claim.locator.room ? `%${claim.locator.room}%` : null;

      // 2) Find an OPEN task of this type matched by linked Room label or the task's own label.
      if (claim.taskType) {
        const found = await c.query<{ id: string }>(
          `SELECT t.id
             FROM objects t
             LEFT JOIN links l ON l.from_object = t.id AND l.relation = 'references'
             LEFT JOIN objects r ON r.id = l.to_object AND r.type = 'Room'
            WHERE t.type = 'Task'
              AND t.properties->>'taskType' = $1
              AND (t.verified_state IS DISTINCT FROM 'verified')
              AND COALESCE((t.properties->>'archived')::boolean, false) = false
              AND (
                    $2::text IS NULL
                 OR r.properties->>'label' = $2
                 OR r.properties->>'label' ILIKE $3
                 OR t.properties->>'label' = $2
                 OR t.properties->>'label' ILIKE $3
              )
            ORDER BY t.created_at DESC
            LIMIT 1`,
          [claim.taskType, roomLabel, roomNeedle],
        );
        if (found.rows[0]) return { objectId: found.rows[0].id, created: false };
      }

      // 3) Create a fresh Task shell to hold the claim (only when asked, and we know the task type).
      if (options.create && claim.taskType) {
        const sop = getSopConfig(claim.taskType);
        const props: Record<string, unknown> = {
          taskType: claim.taskType,
          requiredEvidence: sop.requiredEvidence,
          expectedDurationMin: sop.expectedDurationMin,
          createdBy: 'llm1_listen',
        };
        if (roomLabel) props.label = roomLabel;
        const created = await c.query<{ id: string }>(
          `INSERT INTO objects (tenant_id, type, properties, expected_state) VALUES ($1, 'Task', $2::jsonb, $3) RETURNING id`,
          [tenantId, JSON.stringify(props), sop.expectedState],
        );
        const taskId = created.rows[0]!.id;
        await c.query(
          `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'object.created', $3::jsonb, 'llm1_listen')`,
          [tenantId, taskId, JSON.stringify({ type: 'Task', taskType: claim.taskType, createdBy: 'llm1_listen' })],
        );
        // Link to a matching Room if one exists.
        if (roomLabel) {
          const room = await c.query<{ id: string }>(
            `SELECT id FROM objects WHERE type = 'Room' AND (properties->>'label' = $1 OR properties->>'label' ILIKE $2) LIMIT 1`,
            [roomLabel, roomNeedle],
          );
          if (room.rows[0]) {
            await c.query(
              `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, 'references') ON CONFLICT DO NOTHING`,
              [tenantId, taskId, room.rows[0].id],
            );
          }
        }
        return { objectId: taskId, created: true };
      }

      return null;
    });
  }

  /** Append-only audit: one row per analysis, tracing model + prompt version + applied action. */
  audit(tenantId: string, row: AuditRow): Promise<void> {
    return withTenant(tenantId, async (c: PoolClient) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO llm_analysis_log
           (tenant_id, communication_id, object_id, listener, model, prompt_version, locale,
            event_type, domain, severity, task_type, claimed_state, confidence, applied_action, input, output)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
         RETURNING id`,
        [
          tenantId,
          row.communicationId,
          row.objectId,
          row.listener,
          row.model,
          row.promptVersion,
          row.locale,
          row.eventType,
          row.domain,
          row.severity,
          row.taskType,
          row.claimedState,
          row.confidence,
          row.appliedAction,
          row.input,
          JSON.stringify(row.output ?? {}),
        ],
      );
      // P1-6-b population: mirror the raw analyzed text + full analysis into the redactable
      // side-store, in the SAME transaction (atomic with the audit row). The append-only columns
      // above are left untouched; this store is what the retention sweep later redacts. Empty input
      // is skipped by mirrorText.
      const logId = res.rows[0]?.id;
      if (logId) {
        await this.sensitive.mirrorText(c, tenantId, 'llm_analysis_log', logId, 'input', row.input ?? null);
        await this.sensitive.mirrorJson(c, tenantId, 'llm_analysis_log', logId, 'output', row.output ?? undefined);
      }
    });
  }

  /** Recent analyses for a summary window (what LLM1 HEARD), optionally filtered by domain. */
  gatherAnalyses(tenantId: string, hours: number, domain?: string): Promise<SummaryInputEvent[]> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ created_at: string; event_type: string | null; domain: string | null; task_type: string | null; input: string | null }>(
        `SELECT created_at, event_type, domain, task_type, input
           FROM llm_analysis_log
          WHERE created_at > now() - make_interval(hours => $1)
            AND ($2::text IS NULL OR domain = $2)
          ORDER BY created_at DESC
          LIMIT 500`,
        [hours, domain ?? null],
      );
      return res.rows.map((r) => ({
        at: r.created_at,
        eventType: r.event_type ?? 'other',
        domain: r.domain ?? undefined,
        taskType: r.task_type ?? null,
        text: r.input ?? undefined,
      }));
    });
  }
}
