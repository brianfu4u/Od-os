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

/** A durable transcription work item (see 0018_transcription_jobs.sql). */
export interface TranscriptionJob {
  id: string;
  objectId: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
}

/** A 'processing' job older than this (no completion) is assumed orphaned by a crash and retried. */
export const STALE_JOB_MS = Number(process.env.STT_JOB_STALE_MS) || 10 * 60 * 1000;
/** Give up retrying after this many claims so a permanently-failing job cannot loop forever. */
export const MAX_JOB_ATTEMPTS = Number(process.env.STT_JOB_MAX_ATTEMPTS) || 5;

export interface TranscriptionLogRow {
  objectId: string;
  provider: string;
  model: string | null;
  locale: string | null;
  // C-family: the STT engine's transcription confidence. DELIBERATELY kept as `confidence` in P1-4
  // (a different concept from the S2 verificationScore). Maps to transcription_log.confidence.
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

  /**
   * Durable queue (P0-3): persist a PENDING job BEFORE any processing starts, so a crash mid-flight
   * cannot silently lose the work. Returns the new job id.
   */
  enqueueJob(tenantId: string, objectId: string): Promise<{ id: string }> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO transcription_jobs (tenant_id, object_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
        [tenantId, objectId],
      );
      return { id: res.rows[0]!.id };
    });
  }

  /**
   * Atomically claim a job for this worker: pending → processing (+attempts, +updated_at). Returns
   * true only if THIS call won the row, so two instances can never process the same job at once.
   */
  claimJob(tenantId: string, jobId: string): Promise<boolean> {
    return withTenant(tenantId, async (c) => {
      const res = await c.query(
        `UPDATE transcription_jobs
            SET status = 'processing', attempts = attempts + 1, updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [jobId],
      );
      return (res.rowCount ?? 0) > 0;
    });
  }

  /** Terminal transition: processing → done | failed. `failed` stays retriable via recoverStaleJobs. */
  completeJob(tenantId: string, jobId: string, status: 'done' | 'failed', error: string | null = null): Promise<void> {
    return withTenant(tenantId, async (c) => {
      await c.query(
        `UPDATE transcription_jobs SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
        [jobId, status, error],
      );
    });
  }

  /**
   * Crash recovery: any job stuck in 'processing' past the stale window (its worker died) is reset to
   * 'pending' so it will be picked up again — UNLESS it has already exhausted MAX_JOB_ATTEMPTS, in
   * which case it is marked 'failed' so it stops looping. Returns how many were re-queued.
   */
  recoverStaleJobs(tenantId: string, now: number = Date.now()): Promise<number> {
    const cutoff = new Date(now - STALE_JOB_MS).toISOString();
    return withTenant(tenantId, async (c) => {
      await c.query(
        `UPDATE transcription_jobs SET status = 'failed', last_error = 'exceeded max attempts', updated_at = now()
          WHERE status = 'processing' AND updated_at < $1 AND attempts >= $2`,
        [cutoff, MAX_JOB_ATTEMPTS],
      );
      const res = await c.query(
        `UPDATE transcription_jobs SET status = 'pending', updated_at = now()
          WHERE status = 'processing' AND updated_at < $1 AND attempts < $2`,
        [cutoff, MAX_JOB_ATTEMPTS],
      );
      return res.rowCount ?? 0;
    });
  }

  /** Lists pending jobs for this tenant (FIFO) so a worker can drain them. */
  listPendingJobs(tenantId: string, limit = 20): Promise<TranscriptionJob[]> {
    const capped = Math.min(Math.max(Math.trunc(limit) || 20, 1), 200);
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string; object_id: string; status: TranscriptionJob['status']; attempts: number }>(
        `SELECT id, object_id, status, attempts FROM transcription_jobs
          WHERE status = 'pending' ORDER BY created_at ASC LIMIT $1`,
        [capped],
      );
      return res.rows.map((r) => ({ id: r.id, objectId: r.object_id, status: r.status, attempts: r.attempts }));
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
