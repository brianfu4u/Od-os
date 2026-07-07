-- 0004_rls_and_roles.sql
-- Multi-tenant isolation: Row-Level Security + a least-privilege application role.

-- 1) App role — a NOLOGIN privilege bundle the API assumes per request via
--    `SET LOCAL ROLE clearview_app`. It is NOT the table owner and NOT a superuser,
--    so RLS ALWAYS applies to it. In ops, create a login role and grant membership:
--      CREATE ROLE clearview_login LOGIN PASSWORD '...'; GRANT clearview_app TO clearview_login;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clearview_app') THEN
    CREATE ROLE clearview_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO clearview_app;

-- 2) Current-tenant helper. Reads a transaction-local GUC; default-denies when unset
--    (NULL never matches tenant_id, so no rows are visible without a tenant context).
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

-- 3) Privileges: SELECT/INSERT everywhere; UPDATE/DELETE only on the mutable tables.
--    events + verification_ledger get NO update/delete → append-only at the grant layer.
GRANT SELECT, INSERT, UPDATE, DELETE ON objects TO clearview_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON links   TO clearview_app;
GRANT SELECT, INSERT ON events              TO clearview_app;
GRANT SELECT, INSERT ON verification_ledger TO clearview_app;

-- 4) Enable + FORCE RLS on every tenant-scoped table. FORCE makes even the table
--    owner subject to the policies (defense in depth; superusers still bypass).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['objects', 'links', 'events', 'verification_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;

-- 5) Policies: a row is visible/writable only when its tenant_id matches the session
--    tenant. WITH CHECK stops a session from writing rows into another tenant.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['objects', 'links', 'events', 'verification_ledger'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())',
      t
    );
  END LOOP;
END
$$;
