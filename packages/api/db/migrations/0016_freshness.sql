-- 0016_freshness.sql
-- T-03 · Freshness / activity layer: "how long since this employee's last VALID event".
--
-- WHY: an employee's work STATUS (claimed_status) and their ACTIVITY FRESHNESS are two separate
-- layers (原则 6). Freshness must NOT be folded into claimed_status. It is derived, read-time, from
-- the append-only `events` ledger — so there is a SINGLE authoritative definition of "valid event".
--
-- VALID EVENT WHITELIST (v1.1 必改 3) — only these refresh last_event_at:
--   * employee.status.claimed   — the employee submitted a status
--   * patient.scanned           — the employee scanned a patient (contact)
--   * task.flow.closed
--   * task.flow.rejected
--   * task.flow.shelved         — task-flow key events (real work progression)
--   * patient.flow.advanced     — patient-flow progression (RESERVED; emitted by a future ticket)
--
-- EXPLICITLY NOT VALID (do NOT refresh freshness): SSE heartbeats, page-open / polling reads,
-- attachment uploads that were never submitted, and pure system broadcasts. These simply are not in
-- the whitelist, so a read-time filter on event_type excludes them by construction.
--
-- We DELIBERATELY do NOT store last_event_at as a column (it would drift and need triggers). It is
-- computed from `events` via an IMMUTABLE-vocabulary function + a convenience view. The view is
-- tenant-scoped through RLS on the underlying `events` / `objects` tables (queried inside withTenant).
--
-- SCOPE (additive; no new table, no triplet change, no flow_id/flow_state change).

-- Single source of truth for the whitelist: a set-returning helper the view (and any code that
-- prefers SQL) can share. Kept as a plain function so the vocabulary lives in exactly one place.
CREATE OR REPLACE FUNCTION freshness_valid_event_types()
  RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
AS $$
  SELECT ARRAY[
    'employee.status.claimed',
    'patient.scanned',
    'task.flow.closed',
    'task.flow.rejected',
    'task.flow.shelved',
    'patient.flow.advanced'  -- reserved; harmless until such events exist
  ]::text[];
$$;

-- Convenience view: one row per Staff object with its latest VALID event time (NULL if none yet).
-- NOTE: this is NOT a security boundary on its own; RLS on events/objects (queried inside
-- withTenant → SET LOCAL ROLE clearview_app) scopes it per tenant. `SECURITY INVOKER` (default)
-- ensures the caller's RLS applies.
CREATE OR REPLACE VIEW employee_freshness AS
  SELECT
    s.tenant_id                                                   AS tenant_id,
    s.id                                                          AS employee_id,
    s.claimed_state                                               AS claimed_status,
    MAX(e.created_at) FILTER (
      WHERE e.event_type = ANY (freshness_valid_event_types())
    )                                                             AS last_event_at
  FROM objects s
  LEFT JOIN events e
    ON e.tenant_id = s.tenant_id
   AND e.object_id = s.id
  WHERE s.type = 'Staff'
  GROUP BY s.tenant_id, s.id, s.claimed_state;

GRANT SELECT ON employee_freshness TO clearview_app;

COMMENT ON FUNCTION freshness_valid_event_types() IS
  'The single authoritative whitelist of event_types that refresh an employee''s freshness (last_event_at). Excludes heartbeats, page-open/polling, unsubmitted uploads, and pure system broadcasts by construction.';
COMMENT ON VIEW employee_freshness IS
  'Read-time freshness layer (T-03): per-Staff latest VALID event time (whitelist only). Separate from claimed_status; never gates it. RLS on the underlying tables scopes it per tenant.';
