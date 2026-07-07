-- 0001_objects.sql
-- Generic ontology object store. Every operational object carries the STATE TRIPLET
-- (expected / claimed / verified + confidence). Per-type fields live in `properties`
-- (JSONB) — the store is generic, NOT per-type tables.
-- Source of truth: docs/01-structure-design.md §2; ticket S0-2.

CREATE TABLE IF NOT EXISTS objects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  type           text NOT NULL,
  properties     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- state triplet ---------------------------------------------------------
  expected_state text,
  claimed_state  text,
  verified_state text,
  confidence     numeric(4, 3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  -- timestamps ------------------------------------------------------------
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_objects_tenant      ON objects (tenant_id);
CREATE INDEX IF NOT EXISTS idx_objects_tenant_type ON objects (tenant_id, type);
CREATE INDEX IF NOT EXISTS idx_objects_properties  ON objects USING gin (properties);

-- keep updated_at fresh on every UPDATE
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_objects_updated_at ON objects;
CREATE TRIGGER trg_objects_updated_at
  BEFORE UPDATE ON objects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
