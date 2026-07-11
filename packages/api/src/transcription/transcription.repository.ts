/**
 * All of T4's own database access, always inside withTenant() so RLS is the isolation boundary.
 * It NEVER writes the state triplet (no such method here) — the transcript is persisted as a derived
 * field via ObjectsService.update({ properties }) in the service, and the claim (if any) is applied
 * by LLM1. This repo only: loads the voice evidence to transcribe, appends the immutable
 * transcription_log audit row, and records a semantic transcript.* event for the live stream.
 */
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
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
}
