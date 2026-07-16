-- 0017_session_token_hash.sql
-- P0-2 sub-issue 1: store ONLY a hash of the session token, never the raw token.
-- The sessions table previously kept the opaque bearer token in plaintext (see the TODO in
-- 0007_session_auth.sql). We rename the column to token_hash; the application now writes a SHA-256
-- hash of the token and looks sessions up by that hash. A DB leak therefore exposes hashes, not
-- live credentials.
--
-- BEHAVIOR CHANGE: any pre-migration rows hold raw tokens (not hashes), so they can never match a
-- hashed lookup again — every existing session is invalidated by this migration. We DELETE them so
-- the column truly contains only hashes going forward. Users simply log in again. Idempotent: guarded
-- on the presence of the old `token` column so a re-run is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'sessions' AND column_name = 'token'
  ) THEN
    DELETE FROM sessions;
    ALTER TABLE sessions RENAME COLUMN token TO token_hash;
  END IF;
END
$$;
