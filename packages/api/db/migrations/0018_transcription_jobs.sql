-- 0018_transcription_jobs.sql
-- P0-3 sub-issue 2: make voice transcription DURABLE instead of fire-and-forget.
--
-- Before this, a voice upload kicked STT off with `void transcribeObject(...)` — an unawaited
-- promise with NO persistence. On Render (multi-instance, restarts on every deploy) a job in flight
-- when the process dies is simply LOST: the audio is stored but never transcribed, and nothing
-- records that it still needs doing. This table is the persistent work queue: a row is written
-- (status='pending') BEFORE processing begins, moved to 'processing' when a worker claims it, and to
-- 'done'/'failed' when it finishes. A job left in 'processing' by a crash is recoverable — a stale
-- 'processing' row is reset to 'pending' and retried (see recoverStaleJobs), so no work is lost.
--
-- Tenant-scoped with RLS + FORCE exactly like every other data table; all access is via withTenant()
-- (SET LOCAL ROLE clearview_app). Unlike the append-only logs, this is MUTABLE state (status
-- transitions), so the app role gets UPDATE here.

CREATE TABLE IF NOT EXISTS transcription_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  object_id   uuid NOT NULL,               -- the voice evidence Document to transcribe (same tenant)
  status      text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','done','failed')),
  attempts    integer NOT NULL DEFAULT 0,  -- incremented each claim; bounds retries
  last_error  text,                        -- provider/transport error from the last failed attempt
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcription_jobs_tenant_status ON transcription_jobs (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_transcription_jobs_object        ON transcription_jobs (tenant_id, object_id);

-- Mutable state: SELECT/INSERT/UPDATE (no DELETE — completed jobs are retained as an audit trail and
-- pruned by the lifecycle cleanup instead).
GRANT SELECT, INSERT, UPDATE ON transcription_jobs TO clearview_app;

ALTER TABLE transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcription_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON transcription_jobs;
CREATE POLICY tenant_isolation ON transcription_jobs
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
