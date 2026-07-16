-- 0019_rename_confidence_to_verification_score.sql
-- P1-4 · Rename the misleading `confidence` column to `verification_score`.
--
-- WHY: the value is a DETERMINISTIC, rule-based cross-verification score in [0,1] — NOT a
-- statistical probability / model confidence. The name "confidence" implied statistical certainty
-- it never had. Renaming to `verification_score` makes the semantics honest across the stack.
--
-- SCOPE: pure column rename on the three tables that carry the verification-score concept. No data
-- migration, no type change. Postgres auto-updates each column's inline CHECK expression on rename
-- (the CHECK *constraint names* keep their original `*_confidence_check` spelling — cosmetic only).
--
-- These are the ONLY `confidence` columns that mean "verification score". Other uses of the word
-- (STT transcription confidence, LLM listener confidence, recommendation-candidate confidence) live
-- in JSON `properties` / separate log tables and are DELIBERATELY left untouched.

-- objects.confidence → objects.verification_score  (0001)
ALTER TABLE objects RENAME COLUMN confidence TO verification_score;

-- verification_ledger.confidence → verification_ledger.verification_score  (0003)
ALTER TABLE verification_ledger RENAME COLUMN confidence TO verification_score;

-- employee_status_claims.verification_confidence → employee_status_claims.verification_score  (0014)
ALTER TABLE employee_status_claims RENAME COLUMN verification_confidence TO verification_score;

COMMENT ON COLUMN objects.verification_score IS
  'Deterministic cross-verification score in [0,1] (rule-based, NOT a statistical/model confidence). Renamed from `confidence` in 0019.';
COMMENT ON COLUMN verification_ledger.verification_score IS
  'Deterministic cross-verification score in [0,1] recorded per ledger row (rule-based, NOT a statistical/model confidence). Renamed from `confidence` in 0019.';
COMMENT ON COLUMN employee_status_claims.verification_score IS
  'Deterministic verification score [0,1] of the verification_result (rule-based, NOT statistical). Manager-side reference only; never surfaced to the employee. Renamed from `verification_confidence` in 0019.';
