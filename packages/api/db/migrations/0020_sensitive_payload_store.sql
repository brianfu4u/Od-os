-- 0020_sensitive_payload_store.sql
-- P1-6-a · A1 foundation: a REDACTABLE side-store for sensitive raw content, kept SEPARATE from the
-- append-only audit skeleton and associated by pointer (source_table, source_id, field).
--
-- WHY (compliance / data-minimization, A1 as approved):
--   The append-only ledgers (events / verification_ledger / action_log / llm_analysis_log /
--   patient_scans) intentionally carry an IMMUTABLE audit skeleton — WHO did WHAT, of WHICH type,
--   and WHEN. That skeleton must never be mutated or deleted (forbid_mutation() from 0003, plus
--   withheld UPDATE/DELETE grants). But data-minimization requires that the *sensitive raw content*
--   (analyzed input text, LLM output detail, raw patient identifiers, free-text notes, transcripts)
--   be REDACTABLE once its short retention window elapses.
--
--   A1 resolves the tension by SEPARATION: the immutable skeleton stays exactly as-is; sensitive raw
--   content lives here, in a store that is append-for-write but REDACT-only for mutation. A redaction
--   nulls `content` / `content_jsonb` and stamps `redacted_at` — it can NEVER edit content to a new
--   value and can NEVER delete the row (the audit fact "content X existed and was redacted at T"
--   survives). This is the pointer-associated redactable store Brian approved.
--
-- SCOPE OF THIS TICKET (P1-6-a) — schema FOUNDATION ONLY:
--   * Creates the `sensitive_payloads` table + its redaction primitive (controlled UPDATE) + RLS.
--   * Does NOT migrate existing columns' data into it, does NOT rewrite any read/write path, and
--     does NOT run any retention sweep. Existing sensitive columns (llm_analysis_log.input/.output,
--     patient_scans.patient_code/optional_note, objects transcript) keep working unchanged.
--   * The retention SWEEP that actually populates + redacts this store, the manager-only redacted
--     read views, the access-logging of raw-content views, the provider downgrade switch, and the
--     one-off back-redaction of existing rows are P1-6-b / c / d — NOT here.
--
-- INVARIANT PRESERVED: the 0003 append-only ledgers are NOT touched by this migration. forbid_mutation
-- still blocks ALL update/delete on them. Redaction of already-inlined columns is deferred to b (which
-- will move content into this store, then redact here — never by weakening the ledgers' trigger).

CREATE TABLE IF NOT EXISTS sensitive_payloads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  -- POINTER to the audit-skeleton row this content belongs to. Not an FK: the skeleton lives across
  -- several append-only tables (llm_analysis_log, patient_scans, objects, ...) and RLS + tenant_id
  -- already enforce isolation; a polymorphic (table,id) pointer keeps this store generic.
  source_table  text NOT NULL,        -- e.g. 'llm_analysis_log' | 'patient_scans' | 'objects'
  source_id     uuid NOT NULL,        -- the skeleton row's id
  field         text NOT NULL,        -- e.g. 'input' | 'output' | 'patient_code' | 'transcript'
  -- The sensitive content. Exactly one of the two is used per row (text vs. structured); both are
  -- NULLABLE precisely so redaction can null them. After redaction both are NULL and redacted_at set.
  content       text,
  content_jsonb jsonb,
  -- Redaction marker: NULL = live content retained; non-NULL = content was redacted at this time.
  -- The audit FACT (a payload existed for this pointer, redacted at T) is retained forever.
  redacted_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A live (un-redacted) row must actually carry content; a redacted row must have both cleared.
  CONSTRAINT sensitive_payloads_redaction_consistent CHECK (
    (redacted_at IS NULL  AND (content IS NOT NULL OR content_jsonb IS NOT NULL)) OR
    (redacted_at IS NOT NULL AND content IS NULL AND content_jsonb IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sensitive_payloads_tenant      ON sensitive_payloads (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sensitive_payloads_source      ON sensitive_payloads (tenant_id, source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_sensitive_payloads_tenant_time ON sensitive_payloads (tenant_id, created_at);
-- Lets the future retention sweep (b) find live payloads older than the window cheaply.
CREATE INDEX IF NOT EXISTS idx_sensitive_payloads_live        ON sensitive_payloads (tenant_id, created_at)
  WHERE redacted_at IS NULL;

-- ── Redaction primitive ──────────────────────────────────────────────────────────────────────────
-- This store is INSERT-for-write and REDACT-only for mutation. A trigger allows an UPDATE ONLY when it
-- is a well-formed redaction: content + content_jsonb both become NULL and redacted_at goes from NULL
-- to a value, while the pointer/identity columns (tenant_id, source_table, source_id, field, id,
-- created_at) stay byte-for-byte unchanged. Anything else — editing content to a new value,
-- un-redacting, moving the pointer, or a DELETE — is rejected. Thus content can be destroyed but the
-- audit fact of its prior existence cannot be forged or erased.
CREATE OR REPLACE FUNCTION forbid_nonredaction_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sensitive_payloads is redact-only; DELETE is not allowed';
  END IF;
  -- UPDATE must be a redaction and nothing else.
  IF NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'sensitive_payloads UPDATE must set redacted_at exactly once (redact-only)';
  END IF;
  IF NEW.content IS NOT NULL OR NEW.content_jsonb IS NOT NULL THEN
    RAISE EXCEPTION 'sensitive_payloads redaction must null content and content_jsonb';
  END IF;
  IF NEW.id <> OLD.id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.source_table <> OLD.source_table
     OR NEW.source_id <> OLD.source_id
     OR NEW.field <> OLD.field
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'sensitive_payloads redaction must not alter identity/pointer columns';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sensitive_payloads_redact_only ON sensitive_payloads;
CREATE TRIGGER trg_sensitive_payloads_redact_only
  BEFORE UPDATE OR DELETE ON sensitive_payloads
  FOR EACH ROW EXECUTE FUNCTION forbid_nonredaction_mutation();

-- Grants: SELECT + INSERT + UPDATE (UPDATE is fenced to redaction by the trigger above). NO DELETE.
GRANT SELECT, INSERT, UPDATE ON sensitive_payloads TO clearview_app;

-- RLS: enable + FORCE + the same tenant-isolation policy every data table uses.
ALTER TABLE sensitive_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensitive_payloads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sensitive_payloads;
CREATE POLICY tenant_isolation ON sensitive_payloads
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMENT ON TABLE sensitive_payloads IS
  'P1-6-a A1 foundation: redactable side-store for sensitive raw content, pointer-associated to the append-only audit skeleton. INSERT-for-write, REDACT-only for mutation (content can be nulled + redacted_at stamped; the row/pointer is never deleted or edited to new content). Population + retention sweep + redacted read views are P1-6-b/c/d.';
COMMENT ON COLUMN sensitive_payloads.redacted_at IS
  'NULL = live content retained. Non-NULL = content was redacted at this time; content/content_jsonb are then NULL while the audit fact of prior existence is retained.';
