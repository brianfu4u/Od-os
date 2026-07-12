-- 0012_manager_credentials.sql
-- Manager auth hardening: give a manager a REAL credential so the command center can be signed
-- into with a login + password in production (not only the dev-gated mock or the shared staging
-- password). Additive + backward compatible.
--
-- `manager_identities` (from 0007) maps a manager login → {tenant, manager_id, role}. It is one of
-- the NON-tenant auth tables read on the base `clearview_login` role BEFORE a tenant is known, so it
-- deliberately has NO row-level security (identity lookup is what tells us the tenant). We only ADD
-- two nullable columns here — no RLS change, and no new GRANT: column privileges are inherited from
-- the table-level GRANT SELECT, INSERT, UPDATE, DELETE ON manager_identities TO clearview_login in
-- 0007, which is exactly what the credential login (SELECT) and the seed (UPDATE) need.
--
-- password_hash is a self-describing scrypt encoding (`scrypt$N$r$p$salt$hash`, base64 parts) —
-- NEVER a plaintext password. scrypt is Node's built-in, memory-hard KDF (RFC 7914); using it keeps
-- this change zero-dependency (a bcrypt/argon2 package would require a lockfile update the CI's
-- --frozen-lockfile install forbids). A NULL password_hash means "this manager has no credential
-- login yet" — the /auth/manager/login endpoint rejects it (so existing dev/staging managers that
-- were provisioned without a password keep working via their own gated paths and cannot be logged
-- into by password until one is set).

ALTER TABLE manager_identities ADD COLUMN IF NOT EXISTS password_hash        text;
ALTER TABLE manager_identities ADD COLUMN IF NOT EXISTS password_updated_at  timestamptz;

COMMENT ON COLUMN manager_identities.password_hash IS
  'scrypt$N$r$p$salt$hash (base64). NULL ⇒ no credential login. Never plaintext; set only via the seeder/rotation path.';
COMMENT ON COLUMN manager_identities.password_updated_at IS
  'When password_hash was last set/rotated (audit only).';
