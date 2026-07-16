-- 0019 · P1-4 · Rename the S2 VERIFICATION verdict score: `confidence` → `verification_score`.
--
-- WHY: "confidence" is a deterministic RULE score (see verification/scorer.ts), NOT a real
-- statistical probability. The misleading name invites over-trust in the verdict. This renames the
-- verdict-score columns ONLY.
--
-- SCOPE (A-family = the S2 verdict score, the thing this migration renames):
--   * objects.confidence                         → objects.verification_score
--   * verification_ledger.confidence             → verification_ledger.verification_score
--   * employee_status_claims.verification_confidence → employee_status_claims.verification_score
--
-- DELIBERATELY NOT RENAMED (B/C-family — a different concept; renaming would MANUFACTURE the very
-- semantic conflation P1-4 exists to prevent):
--   * llm_analysis_log.confidence (0010)  — the LLM's OWN analysis confidence ("what the model
--                                            thinks the utterance means"), explicitly "NOT a
--                                            verification confidence" per 0010's own comments.
--   * transcription_log.confidence (0011) — the STT engine's transcription confidence.
--   These stay named `confidence` ON PURPOSE, so a future reader sees the split is intentional,
--   not an oversight. See docs/28-p1-4-verification-score-rename.md.
--
-- SAFE: pure DDL column renames. No row mutation (so the append-only trigger on verification_ledger
-- is not tripped — RENAME COLUMN is DDL, not INSERT/UPDATE/DELETE). Zero data loss. Idempotent via
-- the information_schema guards below.

-- objects.confidence → verification_score
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'objects' AND column_name = 'confidence')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'objects' AND column_name = 'verification_score') THEN
    ALTER TABLE objects RENAME COLUMN confidence TO verification_score;
  END IF;
END $$;

-- verification_ledger.confidence → verification_score
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'verification_ledger' AND column_name = 'confidence')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'verification_ledger' AND column_name = 'verification_score') THEN
    ALTER TABLE verification_ledger RENAME COLUMN confidence TO verification_score;
  END IF;
END $$;

-- employee_status_claims.verification_confidence → verification_score
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'employee_status_claims' AND column_name = 'verification_confidence')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'employee_status_claims' AND column_name = 'verification_score') THEN
    ALTER TABLE employee_status_claims RENAME COLUMN verification_confidence TO verification_score;
  END IF;
END $$;

COMMENT ON COLUMN objects.verification_score IS
  'Deterministic S2 verdict score in [0,1]. A RULE score, NOT a statistical probability. Renamed from `confidence` in 0019 (P1-4).';
COMMENT ON COLUMN verification_ledger.verification_score IS
  'Deterministic S2 verdict score in [0,1] at the time of the verdict. Renamed from `confidence` in 0019 (P1-4).';
COMMENT ON COLUMN employee_status_claims.verification_score IS
  'Score [0,1] of the verification_result. Nullable. Manager-side reference only; never surfaced to the employee. Renamed from `verification_confidence` in 0019 (P1-4).';
