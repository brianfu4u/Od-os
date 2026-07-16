/**
 * All of T4's own database access, always inside withTenant() so RLS is the isolation boundary.
 * It NEVER writes the state triplet (no such method here) — the transcript is persisted as a derived
 * field via ObjectsService.update({ properties }) in the service, and the claim (if any) is applied
 * by LLM1. This repo only: loads the voice evidence to transcribe, appends the immutable
 * transcription_log audit row, records a semantic transcript.* event, and (read-only) lists the
 * tenant's voice transcripts + their verdict for the command-center feed.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { VoiceFeedRecord } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';
import type { TranscriptionStatus } from './transcription.types';

export interface VoiceEvidence {
  id: string;
  type: string;
  kind: string;
  mime: string;
  storageKey: string;
  locale: string | null;
  transcriptStatus: string | null;
}

export interface TranscriptionLogRow {
  objectId: string;
  provider: string;
  model: string | null;
  locale: string | null;
  confidence: number | null;
  chars: number;
  status: TranscriptionStatus;
  error: string | null;
}

@Injectable()
export class TranscriptionRepository {
  /** Load the stored voice evidence object's transcription-relevant metadata (RLS-scoped). */
  loadVoiceEvidence(tenantId: string, id: string): Promise<VoiceEvidence | null> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string; type: string; properties: Record<string, unknown> }>(
        `SELECT id, type, properties FROM objects WHERE id = $1`,
        [id],
      );
      const row = res.rows[0];
      if (!row) return null;
      const p = row.properties ?? {};
      const transcript = (p.transcript && typeof p.transcript === 'object' ? (p.transcript as Record<string, unknown>) : null);
      return {
        id: row.id,
        type: row.type,
        kind: typeof p.kind === 'string' ? p.kind : '',
        mime: typeof p.mime === 'string' ? p.mime : 'application/octet-stream',
        storageKey: typeof p.storageKey === 'string' ? p.storageKey : '',
        locale: typeof p.locale === 'string' ? p.locale : null,
        transcriptStatus: transcript && typeof transcript.status === 'string' ? transcript.status : null,
      };
    });
  }

  /** Append-only audit: one row per transcription attempt (incl. failures), traceable by provider. */
  logTranscription(tenantId: string, row: TranscriptionLogRow): Promise<void> {
    return withTenant(tenantId, async (c: PoolClient) => {
      await c.query(
        `INSERT INTO transcription_log
           (tenant_id, object_id, provider, model, locale, confidence, chars, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, row.objectId, row.provider, row.model, row.locale, row.confidence, row.chars, row.status, row.error],
      );
    });
  }

  /** Records a semantic transcript.* event on the source object (append-only events stream / SSE). */
  recordEvent(tenantId: string, objectId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    return withTenant(tenantId, async (c: PoolClient) => {
      await c.query(
        `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, 'transcription')`,
        [tenantId, objectId, eventType, JSON.stringify(payload)],
      );
    });
  }

  /**
   * Read-only, tenant-scoped feed for the command center: every voice evidence object plus the
   * verdict of the Task its transcript's claim drove (latest such Task via a LATERAL join on
   * `claimedBy`). Runs inside withTenant() so RLS scopes BOTH the documents and the joined tasks to
   * the caller's tenant — a tenant can never see another tenant's transcripts or verdicts. This
   * replaces the client pulling every Document + Task and filtering voice client-side.
   */
  listVoiceFeed(tenantId: string, limit = 100): Promise<VoiceFeedRecord[]> {
    const capped = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{
        id: string;
        properties: Record<string, unknown>;
        updated_at: string;
        verdict_state: string | null;
        verdict_conf: string | null;
      }>(
        `SELECT d.id, d.properties, d.updated_at,
                v.verified_state AS verdict_state, v.verification_score AS verdict_conf
           FROM objects d
           LEFT JOIN LATERAL (
             SELECT t.verified_state, t.verification_score
               FROM objects t
              WHERE t.type = 'Task' AND t.properties->>'claimedBy' = d.id::text
              ORDER BY t.created_at DESC
              LIMIT 1
           ) v ON true
          WHERE d.type IN ('Document', 'Snapshot')
            AND d.properties->>'kind' = 'voice'
          ORDER BY d.updated_at DESC
          LIMIT $1`,
        [capped],
      );
      return res.rows.map((r) => {
        const p = r.properties ?? {};
        const transcript = p.transcript && typeof p.transcript === 'object' ? (p.transcript as Record<string, unknown>) : null;
        const at =
          transcript && typeof transcript.at === 'string'
            ? transcript.at
            : r.updated_at
              ? new Date(r.updated_at).toISOString()
              : null;
        return {
          objectId: r.id,
          at,
          properties: p,
          verdict: r.verdict_state
            ? { verifiedState: r.verdict_state, verificationScore: r.verdict_conf === null ? null : Number(r.verdict_conf) }
            : null,
        };
      });
    });
  }
}
