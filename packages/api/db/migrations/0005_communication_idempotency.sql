-- 0005_communication_idempotency.sql
-- Idempotency for staff reports (S1-2): a Communication's client-supplied message id is
-- unique per tenant, so Mini-Program/webhook retries can never create duplicates even
-- under concurrency. The ingest path also checks-then-inserts, but this is the hard guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_communication_client_msg
  ON objects (tenant_id, (properties ->> 'clientMessageId'))
  WHERE type = 'Communication' AND (properties ? 'clientMessageId');
