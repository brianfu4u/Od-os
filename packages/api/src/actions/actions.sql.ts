import type { PoolClient } from 'pg';
import type { ActionSubject } from './actions.types';

/**
 * Low-level ontology writes used by the action write-backs. Every function takes the caller's
 * withTenant() PoolClient — NONE opens its own connection/transaction — so a whole approval stays
 * atomic and RLS-scoped. Mirrors the patterns in objects.repository.ts / seed.ts.
 */

interface RawObjectRow {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

export async function loadObject(c: PoolClient, id: string): Promise<ActionSubject | null> {
  const res = await c.query<RawObjectRow>(`SELECT id, type, properties FROM objects WHERE id = $1`, [id]);
  const row = res.rows[0];
  return row ? { id: row.id, type: row.type, properties: row.properties ?? {} } : null;
}

export async function emitEvent(
  c: PoolClient,
  tenantId: string,
  objectId: string | null,
  eventType: string,
  payload: Record<string, unknown>,
  actor: string,
): Promise<void> {
  await c.query(
    `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [tenantId, objectId, eventType, JSON.stringify(payload), actor],
  );
}

/** Create an object (emits object.created in the same tx). Returns the new id. */
export async function insertObject(
  c: PoolClient,
  tenantId: string,
  type: string,
  properties: Record<string, unknown>,
  actor: string,
  states: { expected?: string | null; claimed?: string | null; id?: string } = {},
): Promise<string> {
  // An explicit id lets the executor pre-generate the created object's id during planning, so the
  // action_log slot is claimed (with created_object_id known) BEFORE this write runs.
  const withId = typeof states.id === 'string' && states.id.length > 0;
  const res = await c.query<{ id: string }>(
    withId
      ? `INSERT INTO objects (id, tenant_id, type, properties, expected_state, claimed_state)
         VALUES ($6, $1, $2, $3::jsonb, $4, $5) RETURNING id`
      : `INSERT INTO objects (tenant_id, type, properties, expected_state, claimed_state)
         VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`,
    withId
      ? [tenantId, type, JSON.stringify(properties), states.expected ?? null, states.claimed ?? null, states.id]
      : [tenantId, type, JSON.stringify(properties), states.expected ?? null, states.claimed ?? null],
  );
  const id = res.rows[0]!.id;
  await emitEvent(c, tenantId, id, 'object.created', { type, via: 'action' }, actor);
  return id;
}

/**
 * Shallow-merge `patch` into an object's properties. Returns the exact before/after of the KEYS
 * being patched, so an undo can restore precisely (a key absent in `before` is removed on undo).
 */
export async function patchProps(
  c: PoolClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> } | null> {
  const cur = await c.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM objects WHERE id = $1`,
    [id],
  );
  const row = cur.rows[0];
  if (!row) return null;
  const existing = row.properties ?? {};
  const before: Record<string, unknown> = {};
  // Absent keys are recorded as null (NOT undefined — JSON.stringify would drop it, losing the
  // "this key did not exist" signal); restoreProps treats null as "delete on undo".
  for (const k of Object.keys(patch)) before[k] = k in existing ? existing[k] : null;
  const merged = { ...existing, ...patch };
  await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(merged)]);
  return { before, after: { ...patch } };
}

/** Restore specific property keys to a prior snapshot (used by undo). Undefined = delete the key. */
export async function restoreProps(c: PoolClient, id: string, before: Record<string, unknown>): Promise<void> {
  const cur = await c.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM objects WHERE id = $1`,
    [id],
  );
  const row = cur.rows[0];
  if (!row) return;
  const next = { ...(row.properties ?? {}) };
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined || v === null) delete next[k];
    else next[k] = v;
  }
  await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(next)]);
}

/** Soft-archive an object (mirrors objects.repository.softDelete): the undo for create-actions. */
export async function archiveObject(c: PoolClient, tenantId: string, id: string, actor: string): Promise<void> {
  const cur = await c.query<{ properties: Record<string, unknown> }>(
    `SELECT properties FROM objects WHERE id = $1`,
    [id],
  );
  const row = cur.rows[0];
  if (!row) return;
  const props = { ...(row.properties ?? {}), archived: true, archivedAt: new Date().toISOString() };
  await c.query(`UPDATE objects SET properties = $2::jsonb WHERE id = $1`, [id, JSON.stringify(props)]);
  await emitEvent(c, tenantId, id, 'object.archived', { via: 'action.undo' }, actor);
}

export async function addLink(
  c: PoolClient,
  tenantId: string,
  from: string,
  to: string,
  relation: string,
): Promise<void> {
  await c.query(
    `INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [tenantId, from, to, relation],
  );
}
