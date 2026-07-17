-- 0023 · T-13B · Employee-status verification ledger.
--
-- Claims are immutable (0014), so verification must never UPDATE employee_status_claims. This
-- physically separate append-only ledger stores deterministic consistency verdicts for exactly one
-- claim. Its employee-specific enum is intentionally distinct from the generic S2 object ledger.
-- LLM translation confidence is not accepted here and cannot masquerade as verification_score.

CREATE TABLE IF NOT EXISTS employee_status_verification_ledger (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  claim_id              uuid NOT NULL REFERENCES employee_status_claims (id),
  employee_id           uuid NOT NULL REFERENCES objects (id),
  verification_result   text NOT NULL CHECK (
    verification_result IN ('consistent', 'inconsistent', 'insufficient_evidence')
  ),
  verification_score    numeric(4, 3) CHECK (
    verification_score IS NULL OR (verification_score >= 0 AND verification_score <= 1)
  ),
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason                text,
  actor                  text NOT NULL DEFAULT 'system_rule' CHECK (actor IN ('system_rule', 'manager')),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emp_status_verification_claim
  ON employee_status_verification_ledger (tenant_id, claim_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_emp_status_verification_employee
  ON employee_status_verification_ledger (tenant_id, employee_id, created_at DESC, id DESC);

-- Preserve already-recorded 0014/0019 verdicts without mutating the append-only claim table. The
-- marker makes repeat migration runs a no-op. NULL score stays NULL; no score is manufactured.
INSERT INTO employee_status_verification_ledger (
  tenant_id, claim_id, employee_id, verification_result, verification_score,
  evidence, reason, actor, created_at
)
SELECT c.tenant_id, c.id, c.employee_id, c.verification_result, c.verification_score,
       '{"migration":"0023"}'::jsonb, 'Backfilled from legacy claim verification columns',
       'system_rule', c.created_at
  FROM employee_status_claims c
 WHERE c.verification_result IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM employee_status_verification_ledger v
      WHERE v.claim_id = c.id AND v.evidence = '{"migration":"0023"}'::jsonb
   );

-- The trigger validates both tenant and employee ownership without mutating the immutable claim.
CREATE OR REPLACE FUNCTION validate_employee_status_verification_subject() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM employee_status_claims c
     WHERE c.id = NEW.claim_id
       AND c.tenant_id = NEW.tenant_id
       AND c.employee_id = NEW.employee_id
  ) THEN
    RAISE EXCEPTION 'employee-status verification subject does not match claim tenant/employee';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_emp_status_verification_subject
  ON employee_status_verification_ledger;
CREATE TRIGGER trg_emp_status_verification_subject
  BEFORE INSERT ON employee_status_verification_ledger
  FOR EACH ROW EXECUTE FUNCTION validate_employee_status_verification_subject();

DROP TRIGGER IF EXISTS trg_emp_status_verification_append_only
  ON employee_status_verification_ledger;
CREATE TRIGGER trg_emp_status_verification_append_only
  BEFORE UPDATE OR DELETE ON employee_status_verification_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT ON employee_status_verification_ledger TO clearview_app;

ALTER TABLE employee_status_verification_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_status_verification_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON employee_status_verification_ledger;
CREATE POLICY tenant_isolation ON employee_status_verification_ledger
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMENT ON TABLE employee_status_verification_ledger IS
  'Append-only deterministic consistency verdicts for employee status claims. Separate from the generic object verification ledger and from LLM confidence.';
COMMENT ON COLUMN employee_status_verification_ledger.verification_score IS
  'Deterministic employee-status verification score in [0,1], never an LLM translation confidence.';
