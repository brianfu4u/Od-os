-- 0010_llm_analysis_log.sql
-- LLM1 · 「听」(Listen) layer audit trail. Every time LLM1 analyzes a terminal report/event we append
-- one immutable row here: which adapter + model + prompt VERSION produced it, the classification, the
-- CLAIM it extracted, and what LLM1 did with it (applied the claim / left it pending / classified only
-- / error). This makes the LLM layer fully auditable and prompt changes traceable.
--
-- ⛔ MOAT, encoded in the schema: there is deliberately NO verified_state column here. LLM1 records
-- CLAIMS and classifications only; the deterministic cross-verification engine (S2) remains the sole
-- writer of verified_state (on the objects table). `confidence` here is the LLM's analysis confidence,
-- NOT a verification confidence.
--
-- Append-only exactly like events / verification_ledger / action_log:
--   (1) a BEFORE UPDATE OR DELETE trigger (reuses forbid_mutation() from 0003), and
--   (2) withheld UPDATE/DELETE grants for the app role.
-- Tenant-scoped with RLS + FORCE; all reads/writes happen inside withTenant() (SET LOCAL ROLE clearview_app).

CREATE TABLE IF NOT EXISTS llm_analysis_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  -- Source Communication analyzed (same tenant; RLS enforces isolation). Nullable for non-report runs.
  communication_id  uuid,
  -- Object LLM1 acted on (the Task whose claimed_state it set), if any.
  object_id         uuid,
  listener          text NOT NULL,          -- 'deepseek' | 'heuristic'
  model             text,                   -- e.g. 'deepseek-chat' (null for heuristic)
  prompt_version    text NOT NULL,          -- e.g. 'listen.analyze/v1' — traceable prompt lineage
  locale            text,                   -- zh | en | ja
  event_type        text,                   -- classified event type
  domain            text,                   -- classified domain
  severity          text,
  task_type         text,                   -- canonical S0-7 task type, if recognized
  claimed_state     text,                   -- the CLAIM LLM1 extracted (never a verified verdict)
  confidence        numeric,                -- LLM analysis confidence in [0,1] (NOT verification confidence)
  -- What LLM1 did:
  --   claim_applied         = resolved a Task and set its claimed_state (→ deterministic verify)
  --   claim_unresolved      = a confident claim but no Task could be resolved/created → left pending
  --   pending_low_confidence= ambiguous/low-confidence → NOT applied, left pending for humans/S2
  --   cues_only             = no claim; advisory candidate cues fed to the orchestrator
  --   classified_only       = no claim, no cues; classification + audit only
  --   error                 = analysis/apply failed (recorded so the failure is auditable)
  applied_action    text NOT NULL CHECK (applied_action IN
                      ('claim_applied','claim_unresolved','pending_low_confidence','cues_only','classified_only','error')),
  input             text,                   -- the analyzed text (synthetic data only)
  output            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- the full ListenAnalysis
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_log_tenant      ON llm_analysis_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_llm_log_tenant_time ON llm_analysis_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_llm_log_comm        ON llm_analysis_log (tenant_id, communication_id);

-- Append-only: block UPDATE/DELETE via the shared trigger function defined in 0003.
DROP TRIGGER IF EXISTS trg_llm_analysis_log_append_only ON llm_analysis_log;
CREATE TRIGGER trg_llm_analysis_log_append_only
  BEFORE UPDATE OR DELETE ON llm_analysis_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grants: SELECT + INSERT only (no UPDATE/DELETE) → append-only at the grant layer too.
GRANT SELECT, INSERT ON llm_analysis_log TO clearview_app;

-- RLS: enable + FORCE, and the same tenant-isolation policy every data table uses.
ALTER TABLE llm_analysis_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE llm_analysis_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON llm_analysis_log;
CREATE POLICY tenant_isolation ON llm_analysis_log
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
