-- 0006_evidence_sha256.sql
-- Dedup lookup for uploaded evidence (S1-3): find an existing Snapshot/Document with
-- identical content per tenant so we return the existing object instead of storing a
-- duplicate. Not unique — dedup returns the existing row rather than hard-rejecting.
CREATE INDEX IF NOT EXISTS idx_evidence_sha256
  ON objects (tenant_id, (properties ->> 'sha256'))
  WHERE type IN ('Snapshot', 'Document') AND (properties ? 'sha256');
