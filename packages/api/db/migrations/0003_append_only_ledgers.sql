-- 0003_append_only_ledgers.sql
-- APPEND-ONLY event stream + verification ledger (structure-design §4, §5).
-- Append-only is enforced two ways: (1) a trigger that blocks UPDATE/DELETE, and
-- (2) revoked UPDATE/DELETE privileges for the app role (see 0004). FKs to objects
-- use NO ACTION so an audited object cannot be silently hard-deleted (which would
-- otherwise try to mutate these immutable tables).

CREATE TABLE IF NOT EXISTS events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  object_id  uuid REFERENCES objects (id),
  event_type text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_tenant      ON events (tenant_id);
CREATE INDEX IF NOT EXISTS idx_events_object      ON events (object_id);
CREATE INDEX IF NOT EXISTS idx_events_tenant_time ON events (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS verification_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  object_id       uuid NOT NULL REFERENCES objects (id),
  verification_id uuid REFERENCES objects (id),
  verified_state  text NOT NULL,
  confidence      numeric(4, 3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vledger_tenant ON verification_ledger (tenant_id);
CREATE INDEX IF NOT EXISTS idx_vledger_object ON verification_ledger (tenant_id, object_id, created_at);

-- Block mutations: these tables are insert-only.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_append_only ON events;
CREATE TRIGGER trg_events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

DROP TRIGGER IF EXISTS trg_vledger_append_only ON verification_ledger;
CREATE TRIGGER trg_vledger_append_only
  BEFORE UPDATE OR DELETE ON verification_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
