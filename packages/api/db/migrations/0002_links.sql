-- 0002_links.sql
-- Directed, tenant-scoped relations between objects (structure-design §2).
-- Known relations: assignedTo, partOf, uses, consumes, references, verifies,
-- forPatient, forVisit. Stored as free text for extensibility.

CREATE TABLE IF NOT EXISTS links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  from_object uuid NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
  to_object   uuid NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
  relation    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT links_no_self_loop CHECK (from_object <> to_object)
);

CREATE INDEX IF NOT EXISTS idx_links_tenant   ON links (tenant_id);
CREATE INDEX IF NOT EXISTS idx_links_from     ON links (from_object);
CREATE INDEX IF NOT EXISTS idx_links_to       ON links (to_object);
CREATE INDEX IF NOT EXISTS idx_links_relation ON links (tenant_id, relation);
CREATE UNIQUE INDEX IF NOT EXISTS uq_links_edge ON links (tenant_id, from_object, to_object, relation);

-- Integrity: a link and BOTH its endpoints must belong to the same tenant.
CREATE OR REPLACE FUNCTION links_enforce_same_tenant() RETURNS trigger AS $$
DECLARE
  from_tenant uuid;
  to_tenant   uuid;
BEGIN
  SELECT tenant_id INTO from_tenant FROM objects WHERE id = NEW.from_object;
  SELECT tenant_id INTO to_tenant   FROM objects WHERE id = NEW.to_object;
  IF from_tenant IS NULL OR to_tenant IS NULL THEN
    RAISE EXCEPTION 'links: endpoint object not found (from=%, to=%)', NEW.from_object, NEW.to_object;
  END IF;
  IF from_tenant <> NEW.tenant_id OR to_tenant <> NEW.tenant_id THEN
    RAISE EXCEPTION 'links: cross-tenant link rejected (link=%, from=%, to=%)',
      NEW.tenant_id, from_tenant, to_tenant;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_links_same_tenant ON links;
CREATE TRIGGER trg_links_same_tenant
  BEFORE INSERT OR UPDATE ON links
  FOR EACH ROW EXECUTE FUNCTION links_enforce_same_tenant();
