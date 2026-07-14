-- 0015_patient_scan.sql
-- T-02 · PatientScan: a NEUTRAL, append-only "contact" atomic event.
--
-- WHY: when an employee scans a patient code they make contact. The scan records WHO (employee),
-- WHEN (scanned_at), WHICH patient (code + optionally-resolved visit id) and on WHICH terminal.
-- The collection layer assigns NO business semantics — a scan is just a fact that contact happened.
-- Any "what should follow a scan" logic lives ONLY in the manager-side attention rules (T-07), never
-- here, and never as a gate on the employee.
--
-- PATIENT KEY DISCIPLINE (v1.1 必改 4):
--   * `patient_code` is the RAW scanned input; it is ALWAYS kept verbatim for audit.
--   * `patient_visit_id` is the PREFERRED business key for cross-validation; the scan service
--     resolves code → visit_id when it can and backfills it, setting `visit_link_status='resolved'`.
--   * If resolution fails the row STILL persists (`visit_link_status='unresolved'`) — a scan is
--     NEVER blocked. At least one of (patient_code, patient_visit_id) must be present.
--
-- LOW-FRICTION (最小留痕原则): note / attachment / terminal / employee-status-at-scan are all
-- OPTIONAL and never blocking.
--
-- SCOPE (additive; does NOT touch objects triplet, flow_id/flow_state, or S2 verify()).

CREATE TABLE IF NOT EXISTS patient_scans (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL,
  -- WHO: the Staff object that performed the scan (same tenant; RLS + FK enforce it).
  employee_id              uuid NOT NULL REFERENCES objects (id),
  -- PATIENT KEY: raw code kept verbatim; visit_id backfilled when resolvable.
  patient_code             text,
  patient_visit_id         uuid,
  visit_link_status        text NOT NULL DEFAULT 'unresolved'
                             CHECK (visit_link_status IN ('resolved', 'unresolved')),
  -- WHEN + WHERE: client may pass scanned_at; terminal is optional context.
  scanned_at               timestamptz NOT NULL DEFAULT now(),
  terminal_id              text,
  -- Optional, NEVER blocking low-friction extras.
  optional_note            text,
  optional_attachment_ids  uuid[],
  -- Snapshot of the employee's claimed status at scan time (context for cross-validation), optional.
  employee_status_at_scan  text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  -- A scan must identify a patient somehow: raw code OR resolved visit id (or both).
  CONSTRAINT patient_scans_has_key CHECK (patient_code IS NOT NULL OR patient_visit_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_patient_scans_tenant   ON patient_scans (tenant_id);
CREATE INDEX IF NOT EXISTS idx_patient_scans_employee ON patient_scans (tenant_id, employee_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_patient_scans_visit    ON patient_scans (tenant_id, patient_visit_id) WHERE patient_visit_id IS NOT NULL;

-- Append-only: block UPDATE/DELETE via the shared trigger function defined in 0003.
DROP TRIGGER IF EXISTS trg_patient_scans_append_only ON patient_scans;
CREATE TRIGGER trg_patient_scans_append_only
  BEFORE UPDATE OR DELETE ON patient_scans
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Grants: SELECT + INSERT only (no UPDATE/DELETE) → append-only at the grant layer too.
GRANT SELECT, INSERT ON patient_scans TO clearview_app;

-- RLS: enable + FORCE, and the same tenant-isolation policy every data table uses.
ALTER TABLE patient_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_scans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON patient_scans;
CREATE POLICY tenant_isolation ON patient_scans
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMENT ON TABLE patient_scans IS
  'Append-only NEUTRAL contact events (employee scanned a patient code). No business semantics at the collection layer. patient_code is always kept raw; patient_visit_id is backfilled when resolvable (visit_link_status). A scan is never blocked.';
COMMENT ON COLUMN patient_scans.patient_code IS
  'RAW scanned input, kept verbatim for audit. Preferred business key is patient_visit_id when resolvable.';
COMMENT ON COLUMN patient_scans.patient_visit_id IS
  'PREFERRED business key for cross-validation, backfilled from patient_code when resolution succeeds. NULL when unresolved (row still persists).';
COMMENT ON COLUMN patient_scans.visit_link_status IS
  'resolved = patient_code was mapped to a patient_visit_id; unresolved = mapping not (yet) possible. A scan is stored either way.';
