-- 0007_session_auth.sql
-- S0-3 session auth. Two things:
--   (1) a least-privilege LOGIN role the API actually connects as, and
--   (2) non-RLS auth tables for identity + session lookup.
-- Identity/session are resolved BEFORE a tenant is known (the session TELLS us the tenant),
-- so these tables are intentionally OUTSIDE the tenant RLS model and are read only by the server.

-- 1) Login role. Member of clearview_app (inherits its per-table grants), but NOT superuser,
--    NOT BYPASSRLS, NOT the table owner → RLS ALWAYS applies to it. withTenant() still does
--    `SET LOCAL ROLE clearview_app` per request; being a member lets it assume that role.
--    !!! TODO(prod) SECURITY: rotate this password via a secret and set APP_DATABASE_URL
--    explicitly in production. The dev default below is for local/CI synthetic data ONLY. !!!
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearview_login') THEN
    CREATE ROLE clearview_login LOGIN PASSWORD 'clearview_login_dev'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS IN ROLE clearview_app;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO clearview_login;
-- (CONNECT is granted to PUBLIC by default, so no per-database grant is hardcoded here.)

-- 2) Identity + session tables — NO row-level security (pre-tenant lookup surface).
--    staff_identities: WeChat openid → {tenant, staff}. Provisioned by a manager/admin (prod)
--    or by the dev-gated mock login (dev). manager_identities: manager login → {tenant, role}.
CREATE TABLE IF NOT EXISTS staff_identities (
  openid       text PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  staff_id     uuid NOT NULL,
  display_name text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS manager_identities (
  login        text PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  manager_id   uuid NOT NULL,
  role         text NOT NULL DEFAULT 'manager',
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Server-issued opaque session tokens. TODO(prod): store a hash of the token, not the raw token.
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  subject     text NOT NULL CHECK (subject IN ('staff', 'manager')),
  tenant_id   uuid NOT NULL,
  staff_id    uuid,
  manager_id  uuid,
  role        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- 3) The login role reads/writes the auth tables directly (they are NOT tenant-scoped).
--    It does NOT get these grants via clearview_app, so a withTenant() (SET ROLE clearview_app)
--    transaction cannot touch them — auth lookups run on the base clearview_login role only.
-- identity tables are upserted (INSERT ... ON CONFLICT DO UPDATE) → UPDATE is required too.
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_identities  TO clearview_login;
GRANT SELECT, INSERT, UPDATE, DELETE ON manager_identities TO clearview_login;
GRANT SELECT, INSERT, DELETE ON sessions                   TO clearview_login;
