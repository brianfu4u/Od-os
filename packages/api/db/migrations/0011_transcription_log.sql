-- 0011_transcription_log.sql
-- P7 · T4 Speech-to-Text (STT) audit trail. Every time we transcribe a voice evidence Document we
-- append one immutable row here: which STT provider + model produced it, the detected language, the
-- analysis confidence, the outcome status, and how many characters were transcribed. This makes the
-- STT layer fully auditable and lets a review trace every transcription attempt (incl. failures).
--
-- ⛔ MOAT, encoded in the schema: there is deliberately NO verified_state column here. STT only
-- produces DERIVED TEXT (stored on the source Document.properties.transcript) which is then fed to
-- LLM1 as a CLAIM source; the deterministic cross-verification engine (S2) remains the sole writer
-- of verified_state (on the objects table). `confidence` here is the STT/analysis confidence, NOT a
-- verification confidence.
--
-- The transcript TEXT itself lives on the source Document (a derived field, alongside the retained
-- original audio) — this table stays lean (a char count, not the text) and is purely an audit log.
--
-- Append-only exactly like events / verification_ledger / action_log / llm_analysis_log:
--   (1) a BEFORE UPDATE OR DELETE trigger (reuses forbid_mutation() from 0003), and
--   (2) withheld UPDATE/DELETE grants for the app role.
-- Tenant-scoped with RLS + FORCE; all reads/writes happen inside withTenant() (SET LOCAL ROLE clearview_app).

CREATE TABLE IF NOT EXISTS transcription_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  -- The voice evidence Document that was transcribed (same tenant; RLS enforces isolation).
  object_id     uuid,
  provider      text NOT NULL,          -- 'openai' | 'mock' | 'null' | (future) 'tencent' | 'aliyun'
  model         text,                   -- e.g. 'whisper-1' (null for the keyless/null adapter)
  locale        text,                   -- detected language: zh | en | ja | ...
  confidence    numeric,                -- STT confidence in [0,1] (NOT a verification confidence)
  chars         integer,                -- length of the transcript text (the text lives on the Document)
  -- Outcome of the attempt:
  --   done          = transcript produced with acceptable confidence (fed to LLM1)
  --   low_confidence= transcript produced but below threshold → marked, NOT fed to LLM1
  --   failed        = provider/transport error → no text fabricated; retryable (audio retained)
  --   unavailable   = no STT provider configured (keyless) → no text fabricated; retryable
  status        text NOT NULL CHECK (status IN ('done','low_confidence','failed','unavailable')),
  error         text,                   -- provider error message when status='failed'
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcription_log_tenant      ON transcription_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_transcription_log_tenant_time ON transcription_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_transcription_log_object      ON transcription_log (tenant_id, object_id);

-- Append-only: block UPDATE/DELETE via the shared trigger function defined in 0003.
DROP TRIGGER IF EXISTS trg_transcription_log_append_only ON transcription_log;
CREATE TRIGGER trg_transcription_log_append_only
  BEFORE UPDATE OR DELETE ON transcription_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grants: SELECT + INSERT only (no UPDATE/DELETE) → append-only at the grant layer too.
GRANT SELECT, INSERT ON transcription_log TO clearview_app;

-- RLS: enable + FORCE, and the same tenant-isolation policy every data table uses.
ALTER TABLE transcription_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcription_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON transcription_log;
CREATE POLICY tenant_isolation ON transcription_log
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
