-- 0022_event_log.sql
-- T-16 · Phase 0 "Listen" foundation: a neutral, append-only event intake ledger.
--
-- This table records that an input ARRIVED. It does not claim that an operational action happened,
-- does not carry a verdict, and does not trigger any Agent/LLM decision. Photo bytes live behind the
-- StoragePort; the photo event payload contains only a tenant-scoped pointer + integrity metadata.

CREATE TABLE IF NOT EXISTS event_log (
  event_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Clinic OS currently maps one operational store to one tenant. Keeping store_id explicit makes
  -- the Phase 1 correlator contract forward-compatible without trusting a client-supplied store id.
  store_id       uuid NOT NULL,
  terminal_id    text,
  source_type    text NOT NULL,
  event_type     text NOT NULL,
  seq            bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
  occurred_at    timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  subject_hints  jsonb NOT NULL DEFAULT '{}'::jsonb
                   CHECK (jsonb_typeof(subject_hints) = 'object'),
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb
                   CHECK (jsonb_typeof(payload) = 'object'),
  input_modality text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  tenant_id      uuid NOT NULL,

  CONSTRAINT event_log_terminal_id_length CHECK (
    terminal_id IS NULL OR (length(terminal_id) BETWEEN 1 AND 128)
  ),
  -- The present one-store-per-tenant mapping is server-derived. A later store registry can replace
  -- this narrow invariant in the migration that introduces it.
  CONSTRAINT event_log_store_matches_tenant CHECK (store_id = tenant_id),
  -- Last-line payload minimization for T-16 photos: no filename, base64, data URL, binary, free text,
  -- or future LLM output can be smuggled into this immutable row. Other future event types can define
  -- their own versioned payload shapes without weakening this one.
  CONSTRAINT event_log_photo_payload_shape CHECK (
    event_type <> 'evidence.photo.received' OR (
      input_modality = 'photo'
      AND payload ?& ARRAY['storageKey', 'sha256', 'mime', 'size']
      AND payload - ARRAY['storageKey', 'sha256', 'mime', 'size'] = '{}'::jsonb
      AND jsonb_typeof(payload->'storageKey') = 'string'
      AND jsonb_typeof(payload->'sha256') = 'string'
      AND jsonb_typeof(payload->'mime') = 'string'
      AND jsonb_typeof(payload->'size') = 'number'
      AND (payload->>'storageKey') LIKE ('tenant/' || tenant_id::text || '/event-log/%')
      AND (payload->>'sha256') ~ '^[0-9a-f]{64}$'
      AND (payload->>'mime') = 'image/jpeg'
      AND (payload->>'size') ~ '^[1-9][0-9]*$'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_event_log_tenant_received
  ON event_log (tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_log_tenant_terminal_seq
  ON event_log (tenant_id, terminal_id, seq);
CREATE INDEX IF NOT EXISTS idx_event_log_store_occurred
  ON event_log (tenant_id, store_id, occurred_at DESC);

-- Immutable intake facts: trigger + withheld UPDATE/DELETE privileges are independent defenses.
DROP TRIGGER IF EXISTS trg_event_log_append_only ON event_log;
CREATE TRIGGER trg_event_log_append_only
  BEFORE UPDATE OR DELETE ON event_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

REVOKE UPDATE, DELETE ON event_log FROM clearview_app;
GRANT SELECT, INSERT ON event_log TO clearview_app;

ALTER TABLE event_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON event_log;
CREATE POLICY tenant_isolation ON event_log
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

COMMENT ON TABLE event_log IS
  'T-16 neutral append-only Listen ledger. Records received inputs only; never a business verdict or proof that an operational consequence occurred.';
COMMENT ON COLUMN event_log.subject_hints IS
  'Non-sensitive correlation hints only. T-16 writes server-derived actor ids; raw text/PHI belongs in sensitive_payloads, never here.';
COMMENT ON COLUMN event_log.payload IS
  'Versioned structural facts only. T-16 photo rows contain StoragePort pointer, SHA-256, MIME, and byte size; never image bytes or sensitive raw text.';
