-- 0021_objects_verification_guard.sql
-- P0-1 · LAST LINE OF DEFENSE for the "listen to claims, verify behavior" invariant.
--
-- verified_state / verification_score on `objects` are the deterministic S2 verdict. They must ONLY
-- ever be written by the Verification Service's write path — never by the generic /objects API, a
-- stray UPDATE, or any other code path. The API + DTO layers already remove those fields from the
-- public write surface (P0-1); this trigger is the database-level backstop so that even a direct SQL
-- UPDATE cannot flip verified_state to 'verified' / verification_score to 1 and fake a verdict.
--
-- Mechanism (mirrors the existing app.tenant_id GUC convention):
--   The Verification Service runs `SET LOCAL app.verification_write = 'true'` inside its transaction
--   immediately before its UPDATE. This BEFORE UPDATE trigger fires on every objects UPDATE and, if
--   verified_state OR verification_score actually CHANGES (IS DISTINCT FROM, NULL-safe) while that
--   session flag is not 'true', raises an exception and blocks the write.
--
-- Narrowly scoped on purpose:
--   * Only UPDATEs that CHANGE verified_state/verification_score are ever blocked. Any other column
--     change (properties, expected_state, claimed_state, archived, ...) passes untouched.
--   * INSERTs are not guarded (seeds / new objects insert their initial verdict directly; a fresh
--     API object now inserts NULL). Only the transition of the verdict on an existing row matters.

CREATE OR REPLACE FUNCTION forbid_unverified_verdict_write() RETURNS trigger AS $$
BEGIN
  IF (NEW.verified_state IS DISTINCT FROM OLD.verified_state
      OR NEW.verification_score IS DISTINCT FROM OLD.verification_score)
     AND current_setting('app.verification_write', true) IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'objects.verified_state/verification_score may only be written by the Verification Service (S2)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_objects_verdict_guard ON objects;
CREATE TRIGGER trg_objects_verdict_guard
  BEFORE UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION forbid_unverified_verdict_write();
