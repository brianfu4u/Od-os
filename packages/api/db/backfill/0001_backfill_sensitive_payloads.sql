-- 0001_backfill_sensitive_payloads.sql
-- P1-6-d · E-1 one-off, IDEMPOTENT backfill of the redactable side-store from EXISTING skeleton rows.
--
-- WHY: P1-6-b started dual-writing sensitive raw content into sensitive_payloads at write time, but
-- rows written BEFORE that (and, defensively, any row that missed a mirror) have no side-store entry,
-- so the retention sweep can never redact them. This backfill mirrors the sensitive columns of the
-- existing append-only rows into sensitive_payloads so the sweep covers historical data too (E-1:
-- "make existing data compliant on launch").
--
-- SCOPE / SAFETY (matches P1-6-d D-choice-1, no architecture change):
--   * PURE INSERT into sensitive_payloads only. It NEVER touches the append-only skeleton tables
--     (patient_scans / llm_analysis_log) — no UPDATE, no DELETE, no DROP, no trigger/grant change.
--     The append-only "last line of defence" is never opened, not even once (Brian's P0-1 principle).
--   * IDEMPOTENT: a NOT EXISTS guard skips any pointer (source_table, source_id, field) that already
--     has a mirror, so re-running inserts nothing new.
--   * created_at is COPIED FROM THE SOURCE ROW, so an already-expired historical row is redacted by
--     the very next retention sweep (E-1 intent), not given a fresh 30-day lease.
--   * Only NON-EMPTY sensitive content is mirrored (NULL / '' produce nothing to retain).
--   * Runs per-tenant safe: sensitive_payloads.tenant_id is copied from the source row; RLS/tenant
--     isolation is unaffected (this script is run by the migrator/admin role, like other db scripts).
--
-- FIELDS mirrored (the four currently dual-written by P1-6-b):
--   patient_scans.patient_code, patient_scans.optional_note,
--   llm_analysis_log.input (text), llm_analysis_log.output (jsonb).

BEGIN;

-- 1) patient_scans.patient_code  (text)
INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content, created_at)
SELECT ps.tenant_id, 'patient_scans', ps.id, 'patient_code', ps.patient_code, ps.created_at
  FROM patient_scans ps
 WHERE ps.patient_code IS NOT NULL AND ps.patient_code <> ''
   AND NOT EXISTS (
     SELECT 1 FROM sensitive_payloads sp
      WHERE sp.tenant_id = ps.tenant_id AND sp.source_table = 'patient_scans'
        AND sp.source_id = ps.id AND sp.field = 'patient_code'
   );

-- 2) patient_scans.optional_note  (text)
INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content, created_at)
SELECT ps.tenant_id, 'patient_scans', ps.id, 'optional_note', ps.optional_note, ps.created_at
  FROM patient_scans ps
 WHERE ps.optional_note IS NOT NULL AND ps.optional_note <> ''
   AND NOT EXISTS (
     SELECT 1 FROM sensitive_payloads sp
      WHERE sp.tenant_id = ps.tenant_id AND sp.source_table = 'patient_scans'
        AND sp.source_id = ps.id AND sp.field = 'optional_note'
   );

-- 3) llm_analysis_log.input  (text)
INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content, created_at)
SELECT l.tenant_id, 'llm_analysis_log', l.id, 'input', l.input, l.created_at
  FROM llm_analysis_log l
 WHERE l.input IS NOT NULL AND l.input <> ''
   AND NOT EXISTS (
     SELECT 1 FROM sensitive_payloads sp
      WHERE sp.tenant_id = l.tenant_id AND sp.source_table = 'llm_analysis_log'
        AND sp.source_id = l.id AND sp.field = 'input'
   );

-- 4) llm_analysis_log.output  (jsonb)
-- The column is NOT NULL DEFAULT '{}'::jsonb, so we skip the trivial empty object (nothing sensitive)
-- to match the dual-write's "skip empty" intent and avoid mirroring meaningless {} payloads.
INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content_jsonb, created_at)
SELECT l.tenant_id, 'llm_analysis_log', l.id, 'output', l.output, l.created_at
  FROM llm_analysis_log l
 WHERE l.output IS NOT NULL AND l.output <> '{}'::jsonb
   AND NOT EXISTS (
     SELECT 1 FROM sensitive_payloads sp
      WHERE sp.tenant_id = l.tenant_id AND sp.source_table = 'llm_analysis_log'
        AND sp.source_id = l.id AND sp.field = 'output'
   );

COMMIT;
