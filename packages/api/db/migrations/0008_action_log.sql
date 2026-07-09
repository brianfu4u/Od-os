-- 0008_action_log.sql
-- P2 · S4 action write-back layer. When a manager APPROVES a recommendation and its action is on
-- the low-risk internal write-back whitelist, we execute an ontology write-back and record it here.
-- `action_log` is an APPEND-ONLY ledger, exactly like events / verification_ledger:
--   (1) a BEFORE UPDATE OR DELETE trigger (reuses forbid_mutation() from 0003), and
--   (2) withheld UPDATE/DELETE grants for the app role (below).
-- It is tenant-scoped with RLS + FORCE, and reads/writes only ever happen inside withTenant()
-- (SET LOCAL ROLE clearview_app). High-risk actions are NEVER executed — they are recorded here
-- with result='blocked_high_risk' so the refusal itself is auditable.

CREATE TABLE IF NOT EXISTS action_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  -- The approved Recommendation object this action came from (same tenant; RLS + FK enforce it).
  recommendation_id uuid NOT NULL REFERENCES objects (id),
  action_type       text NOT NULL,
  -- executed        = whitelisted low-risk internal write-back actually applied
  -- blocked_high_risk = a high-risk action was approved but deliberately NOT executed
  -- recorded_intent = nothing to auto-execute (a nudge/manual action); intent logged only
  -- not_executable  = a whitelisted action could not run (e.g. missing target) — logged, not applied
  -- undone          = a prior executed action was reversed (restores the recorded before-state)
  result            text NOT NULL CHECK (result IN ('executed', 'blocked_high_risk', 'recorded_intent', 'not_executable', 'undone')),
  risk_tier         text,
  actor             text,
  target_object_id  uuid,          -- object mutated by the write-back (reassign/equipment), if any
  created_object_id uuid,          -- object created by the write-back (reorder/equipment/review), if any
  params            jsonb NOT NULL DEFAULT '{}'::jsonb,
  before            jsonb,         -- prior state captured for undo (reversible actions)
  after             jsonb,         -- resulting state
  undoable          boolean NOT NULL DEFAULT false,
  undo_of           uuid,          -- for result='undone': the action_log row being reversed
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_log_tenant ON action_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_action_log_rec    ON action_log (tenant_id, recommendation_id, created_at);

-- Idempotency, enforced by the database (race-safe): at most ONE executed action and at most ONE
-- undo per recommendation per tenant. The executor INSERTs with ON CONFLICT DO NOTHING and only
-- performs the world write when it wins the slot (RETURNING a row).
CREATE UNIQUE INDEX IF NOT EXISTS action_log_executed_once ON action_log (tenant_id, recommendation_id) WHERE result = 'executed';
CREATE UNIQUE INDEX IF NOT EXISTS action_log_undone_once   ON action_log (tenant_id, recommendation_id) WHERE result = 'undone';

-- Append-only: block UPDATE/DELETE via the shared trigger function defined in 0003.
DROP TRIGGER IF EXISTS trg_action_log_append_only ON action_log;
CREATE TRIGGER trg_action_log_append_only
  BEFORE UPDATE OR DELETE ON action_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grants: SELECT + INSERT only (no UPDATE/DELETE) → append-only at the grant layer too.
GRANT SELECT, INSERT ON action_log TO clearview_app;

-- RLS: enable + FORCE, and the same tenant-isolation policy every data table uses.
ALTER TABLE action_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON action_log;
CREATE POLICY tenant_isolation ON action_log
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
