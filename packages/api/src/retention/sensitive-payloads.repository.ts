import type { PoolClient } from 'pg';
import { withTenant } from '../database/tenant-context';
import { resolveRetentionConfig } from './retention.config';

/**
 * Write + retention access to the P1-6-a `sensitive_payloads` redactable side-store.
 *
 * POPULATION (P1-6-b): raw content is MIRRORED here at write time, in the SAME transaction as the
 * append-only skeleton row it belongs to, and pointer-associated via (source_table, source_id,
 * field). The original skeleton columns are left untouched in this ticket — this store exists so the
 * retention sweep can later redact the raw content while the audit fact of its prior existence
 * survives on the immutable ledger. Empty/absent values are skipped (nothing sensitive to store).
 *
 * The population helpers take an existing PoolClient so the caller controls the transaction (atomic
 * with the skeleton INSERT). The sweep opens its own tenant-scoped transaction.
 */
export class SensitivePayloadsRepository {
  /**
   * Mirror one text field into the side-store, inside the caller's transaction. No-op for
   * null/empty content (nothing sensitive to retain).
   */
  async mirrorText(
    c: PoolClient,
    tenantId: string,
    sourceTable: string,
    sourceId: string,
    field: string,
    content: string | null | undefined,
  ): Promise<void> {
    if (content === null || content === undefined || content === '') return;
    await c.query(
      `INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, sourceTable, sourceId, field, content],
    );
  }

  /**
   * Mirror one jsonb field into the side-store, inside the caller's transaction. No-op for
   * null/undefined (an empty object {} is still stored — it is a real, if trivial, payload only when
   * explicitly provided; callers pass undefined to skip).
   */
  async mirrorJson(
    c: PoolClient,
    tenantId: string,
    sourceTable: string,
    sourceId: string,
    field: string,
    content: unknown,
  ): Promise<void> {
    if (content === null || content === undefined) return;
    await c.query(
      `INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content_jsonb)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [tenantId, sourceTable, sourceId, field, JSON.stringify(content)],
    );
  }

  /**
   * P1-6-d · D-choice-1 read-path closure. Read the LIVE (un-redacted) sensitive content for one
   * pointer, INSIDE the caller's tenant transaction. Returns the newest live payload's content, or
   * `null` when it is absent OR already redacted — so read paths resolve sensitive raw material via
   * the redactable side-store instead of the append-only source column. A redacted / missing payload
   * therefore yields "unreadable", and callers MUST NOT fall back to the plaintext source column
   * (KI-001): the append-only skeleton column is never read for sensitive content once closed.
   *
   * `redacted_at IS NULL` guarantees we never resurrect swept content; ORDER BY created_at DESC picks
   * the most recent mirror for the pointer. Returns text content only (the two current closed fields
   * — patient_code, llm input — are text); jsonb payloads are out of scope for this helper.
   */
  async readLivePayload(
    c: PoolClient,
    tenantId: string,
    sourceTable: string,
    sourceId: string,
    field: string,
  ): Promise<string | null> {
    const res = await c.query<{ content: string | null }>(
      `SELECT content
         FROM sensitive_payloads
        WHERE tenant_id = $1 AND source_table = $2 AND source_id = $3 AND field = $4
          AND redacted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, sourceTable, sourceId, field],
    );
    return res.rows[0]?.content ?? null;
  }

  /**
   * Retention sweep: redact every LIVE payload older than the configured window, using the 0020
   * redact-only primitive (content + content_jsonb → NULL, redacted_at stamped once). Idempotent —
   * already-redacted rows (redacted_at IS NOT NULL) are excluded, so a re-run redacts nothing new.
   * The append-only skeleton is untouched. Returns the count redacted.
   */
  async sweep(tenantId: string, env: Record<string, string | undefined> = process.env): Promise<{ redacted: number }> {
    const { rawContentDays } = resolveRetentionConfig(env);
    return withTenant(tenantId, async (c) => {
      const res = await c.query<{ id: string }>(
        `UPDATE sensitive_payloads
            SET content = NULL, content_jsonb = NULL, redacted_at = now()
          WHERE redacted_at IS NULL
            AND created_at < now() - make_interval(days => $1)
        RETURNING id`,
        [rawContentDays],
      );
      return { redacted: res.rowCount ?? 0 };
    });
  }
}
