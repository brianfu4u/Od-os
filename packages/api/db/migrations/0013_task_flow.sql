-- 0013_task_flow.sql
-- Task-flow closure model: "one task = one flow, from creation to closure".
--
-- WHY: replaces the (never-merged, PR #32/#33) automatic resubmission/escalation model with a
-- single-authority manager decision. A Task now carries an explicit, persistent flow identity and a
-- flow lifecycle state that ONLY a manager's explicit APPROVE can move to the terminal `closed`.
-- Rejection — any number of times — never closes the flow; it resets it to `pending` within the SAME
-- flow. There is no automatic escalation because the manager is always already the decision authority.
--
-- SCOPE (additive, backward compatible — no RLS change, privileges inherited from 0001's table GRANT):
--   * flow_id    uuid  — stable flow identity, minted at Task creation, unchanged for the task's life.
--                        Backfilled for existing Tasks to their own object id (each existing task IS
--                        its own flow). NULL for non-Task objects.
--   * flow_state text  — 'pending' | 'closed'. 'pending' = still in the manager's queue / open for a
--                        decision (initial + after any REJECT). 'closed' = terminal, one-way, set ONLY
--                        on manager APPROVE. There is NO reopening of a closed flow (enforced in code).
--                        Backfilled for existing Tasks to 'pending'. NULL for non-Task objects.
--
-- flow_state is deliberately SEPARATE from verified_state: verified_state remains the S2 scorer's
-- authoritative verdict (confidence / missing-evidence) and is NOT a gate — it is reference data
-- attached to the manager's queue item. The flow lifecycle is owned by the manager decision, not S2.
--
-- Audit fields (employee_id / manager_id / rejection_reason_category / rejection_reason_detail /
-- task_difficulty_tag / task_type_tag) live on the append-only `events` ledger payloads (the flow
-- decision events) and are additionally projected onto Task.properties for cheap read paths. No new
-- column is needed for them here; the flow_id column is what ties every event and projection together.

ALTER TABLE objects ADD COLUMN IF NOT EXISTS flow_id    uuid;
ALTER TABLE objects ADD COLUMN IF NOT EXISTS flow_state text;

-- Guard: flow_state, when set, is one of the two legal lifecycle values.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'objects_flow_state_check'
  ) THEN
    ALTER TABLE objects
      ADD CONSTRAINT objects_flow_state_check
      CHECK (flow_state IS NULL OR flow_state IN ('pending', 'closed'));
  END IF;
END$$;

-- Backfill existing Tasks: each is its own flow, initially open (pending). Non-Tasks stay NULL.
UPDATE objects SET flow_id = id           WHERE type = 'Task' AND flow_id IS NULL;
UPDATE objects SET flow_state = 'pending' WHERE type = 'Task' AND flow_state IS NULL;

-- Queryability: find a flow by id, and list open/closed flows within a tenant (bidirectional lookups
-- employee↔manager are served by the events ledger joined on flow_id / object_id, not by a column).
CREATE INDEX IF NOT EXISTS idx_objects_flow_id           ON objects (flow_id) WHERE flow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_objects_tenant_flow_state ON objects (tenant_id, flow_state) WHERE flow_state IS NOT NULL;

COMMENT ON COLUMN objects.flow_id IS
  'Stable flow identity for a Task, minted at creation and unchanged for its whole life. Every flow decision event (task.flow.closed / task.flow.rejected / task.flow.shelved) carries this id in its payload. NULL for non-Task objects.';
COMMENT ON COLUMN objects.flow_state IS
  'Task flow lifecycle: pending | closed. pending = open for a manager decision (initial + after any REJECT, same flow). closed = terminal, one-way, set ONLY on manager APPROVE; never reopened. NULL for non-Task objects. Separate from verified_state (S2 reference verdict, not a gate).';
