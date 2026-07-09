-- 0009_learning.sql
-- P4 · S8 learning loop. Three tables:
--   learning_feedback — APPEND-ONLY signal stream (approve/dismiss/snooze/undo + verdict corrections)
--   learning_params   — MUTABLE per-tenant parameter overrides S2/S3 read back (weights/threshold/penalty)
--   learning_audit    — APPEND-ONLY record of every learn run (what changed, basis, before/after), reversible
-- feedback + audit follow the events/verification_ledger discipline: forbid_mutation trigger (0003) +
-- withheld UPDATE/DELETE grants. All three are tenant-scoped with RLS + FORCE + the tenant_isolation policy.

-- 1) Append-only feedback stream.
CREATE TABLE IF NOT EXISTS learning_feedback (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN (
                      'recommendation_approved', 'recommendation_dismissed', 'recommendation_snoozed',
                      'recommendation_undone', 'verdict_correction')),
  domain            text,          -- recommendation domain (reco feedback)
  action_type       text,          -- proposed action type (reco feedback)
  task_type         text,          -- task type (verdict correction / reco subject)
  object_id         uuid,          -- subject object
  recommendation_id uuid,          -- source recommendation (reco feedback)
  from_state        text,          -- verdict correction: prior verified_state
  to_state          text,          -- verdict correction: corrected verified_state
  evidence_kinds    text[],        -- verdict correction: evidence kinds present at correction time
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lfeedback_tenant     ON learning_feedback (tenant_id);
CREATE INDEX IF NOT EXISTS idx_lfeedback_tenant_knd ON learning_feedback (tenant_id, kind, created_at);

-- 2) Mutable per-tenant parameter overrides. One row per (tenant, param_type, param_key).
--    param_type 'task'            → value {weights:{kind:number}, threshold?:number, base?:number}
--    param_type 'domain_priority' → value {penalty:number}
CREATE TABLE IF NOT EXISTS learning_params (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  param_type  text NOT NULL CHECK (param_type IN ('task', 'domain_priority')),
  param_key   text NOT NULL,
  value       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, param_type, param_key)
);
CREATE INDEX IF NOT EXISTS idx_lparams_tenant ON learning_params (tenant_id, param_type);

-- 3) Append-only audit of learn runs. One run_id groups the per-field changes it made.
CREATE TABLE IF NOT EXISTS learning_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  run_id      uuid NOT NULL,
  param_type  text NOT NULL,
  param_key   text NOT NULL,
  field       text NOT NULL,         -- e.g. 'weights.snapshot', 'threshold', 'penalty'
  before      jsonb,
  after       jsonb,
  basis       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {sampleSize, signal, ...} the evidence for the change
  kind        text NOT NULL DEFAULT 'adjust' CHECK (kind IN ('adjust', 'rollback', 'noop')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_laudit_tenant ON learning_audit (tenant_id, run_id, created_at);

-- Append-only guards on feedback + audit (reuse the shared trigger fn from 0003).
DROP TRIGGER IF EXISTS trg_lfeedback_append_only ON learning_feedback;
CREATE TRIGGER trg_lfeedback_append_only
  BEFORE UPDATE OR DELETE ON learning_feedback
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS trg_laudit_append_only ON learning_audit;
CREATE TRIGGER trg_laudit_append_only
  BEFORE UPDATE OR DELETE ON learning_audit
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grants: feedback + audit are insert-only for the app role; params are fully mutable.
GRANT SELECT, INSERT ON learning_feedback TO clearview_app;
GRANT SELECT, INSERT ON learning_audit    TO clearview_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON learning_params TO clearview_app;

-- RLS: enable + FORCE + tenant isolation on all three.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['learning_feedback', 'learning_params', 'learning_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END
$$;
