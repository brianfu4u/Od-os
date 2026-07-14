-- 0014_employee_status.sql
-- T-01 · Employee work-status: claim layer vs verification-result layer, kept STRICTLY separate.
--
-- WHY: a front-line employee declares their own work status (five states). That declaration is a
-- CLAIM — never rejected, never blocked, never reworked. A silent background LLM/rule check may later
-- decide whether the claim is CONSISTENT with observed evidence; that is a VERIFICATION RESULT, not
-- "the system's finding of the employee's real status". The two must never collapse into one `status`.
--
-- MODEL (single object philosophy — NO second employee entity model):
--   * CURRENT status lives on the existing Staff object (objects type='Staff'):
--       - claimed_state  ← the employee's current claimed_status (source of truth for "what they say")
--       - verified_state ← the verification_result (consistency enum ONLY; see values below)
--       - confidence     ← the verification_confidence (nullable)
--     We reuse 0001's state triplet columns; we DO NOT add per-employee status columns.
--   * HISTORY lives in a new APPEND-ONLY side table `employee_status_claims` (exactly like
--     action_log / events / verification_ledger): every claim submission appends one immutable row.
--
-- SCOPE (additive, backward compatible; does NOT touch flow_id / flow_state / S2 verify()):
--   * new append-only ledger `employee_status_claims`
--   * a CHECK-constrained five-state vocabulary + a claim_source vocabulary
--   * verification_result on the ledger is the consistency enum, distinct from any "real status"
--
-- NAMING DISCIPLINE (aligned with the flow refactor's claim-vs-verified convention):
--   claimed_status  = what the employee declares          (claim layer)
--   verification_result = did the claim match the evidence (verification layer; NOT real status)
--   world state     = Staff object columns updated by the write path (see employee-status module)

-- Five legal work states (status machine). Values are stable string codes; UI localises them.
--   on_duty | busy | idle | rest | off_duty
-- claim_source records HOW the claim arrived (button tap is the norm; others reserved).
--   button | api | system_default
-- verification_result is the consistency verdict — NOT the employee's real status:
--   consistent | inconsistent | insufficient_evidence   (NULL = not yet checked)

CREATE TABLE IF NOT EXISTS employee_status_claims (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  -- The Staff object whose current status this claim updates (same tenant; RLS + FK enforce it).
  employee_id            uuid NOT NULL REFERENCES objects (id),
  -- CLAIM LAYER: what the employee declares. Five-state vocabulary, never rejected.
  claimed_status         text NOT NULL CHECK (claimed_status IN ('on_duty', 'busy', 'idle', 'rest', 'off_duty')),
  claim_source           text NOT NULL DEFAULT 'button' CHECK (claim_source IN ('button', 'api', 'system_default')),
  -- VERIFICATION LAYER (nullable, filled later by silent background check ONLY): a consistency
  -- verdict, deliberately NOT a "real status". Never flows back to the employee; never overrides
  -- claimed_status; an `inconsistent` result only spawns a manager attention item (T-06/T-07).
  verification_result    text CHECK (verification_result IS NULL OR verification_result IN ('consistent', 'inconsistent', 'insufficient_evidence')),
  verification_confidence numeric(4, 3) CHECK (verification_confidence IS NULL OR (verification_confidence >= 0 AND verification_confidence <= 1)),
  -- Optional, low-friction, NEVER blocking: a voluntary free-text note left with the status change.
  note                   text,
  -- When the employee made the claim (client may pass; defaults to insert time).
  claimed_at             timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Latest-claim-per-employee and history scans are the hot read paths.
CREATE INDEX IF NOT EXISTS idx_emp_status_tenant   ON employee_status_claims (tenant_id);
CREATE INDEX IF NOT EXISTS idx_emp_status_employee ON employee_status_claims (tenant_id, employee_id, claimed_at DESC);

-- Append-only: block UPDATE/DELETE via the shared trigger function defined in 0003.
DROP TRIGGER IF EXISTS trg_emp_status_append_only ON employee_status_claims;
CREATE TRIGGER trg_emp_status_append_only
  BEFORE UPDATE OR DELETE ON employee_status_claims
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grants: SELECT + INSERT only (no UPDATE/DELETE) → append-only at the grant layer too.
GRANT SELECT, INSERT ON employee_status_claims TO clearview_app;

-- RLS: enable + FORCE, and the same tenant-isolation policy every data table uses.
ALTER TABLE employee_status_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_status_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee_status_claims;
CREATE POLICY tenant_isolation ON employee_status_claims
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMENT ON TABLE employee_status_claims IS
  'Append-only history of employee work-status CLAIMS (five states). Current status is projected onto the Staff object (objects.claimed_state); this table is the immutable claim ledger, NOT a second employee entity model.';
COMMENT ON COLUMN employee_status_claims.claimed_status IS
  'CLAIM LAYER: the employee''s self-declared work status. Never rejected/blocked. One of on_duty|busy|idle|rest|off_duty.';
COMMENT ON COLUMN employee_status_claims.verification_result IS
  'VERIFICATION LAYER: consistency verdict of claim vs observed evidence (consistent|inconsistent|insufficient_evidence). NULL until a silent background check runs. NOT the employee''s real status; never overrides claimed_status; never returned to the employee.';
COMMENT ON COLUMN employee_status_claims.verification_confidence IS
  'Confidence [0,1] of the verification_result. Nullable. Manager-side reference only; never surfaced to the employee.';
