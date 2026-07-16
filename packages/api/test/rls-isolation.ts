/**
 * S0-2 acceptance test: proves cross-tenant isolation under Row-Level Security.
 *
 * Runs against $DATABASE_URL (must be migrated first). Connects as the owner, then
 * downgrades to the RLS-restricted `clearview_app` role per check — exactly the
 * runtime path in src/database/tenant-context.ts. Uses two throwaway random tenant
 * ids so it is independent of seed data, and cleans up after itself.
 *
 * Exit code 0 = all checks passed; 1 = a check failed.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';

let passed = 0;
let failed = 0;

function check(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function main(): Promise<void> {
  const connectionString = requireDatabaseUrl();
  const A = randomUUID();
  const B = randomUUID();
  const c = new Client({ connectionString });
  await c.connect();

  // Seed one visible object per tenant (as owner → bypasses RLS).
  const rx = await c.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, expected_state) VALUES ($1, 'Room', 'ready') RETURNING id`,
    [A],
  );
  const ry = await c.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, expected_state) VALUES ($1, 'Room', 'ready') RETURNING id`,
    [B],
  );
  const idX = rx.rows[0]!.id;
  const idY = ry.rows[0]!.id;

  try {
    console.log('RLS cross-tenant isolation checks:');

    // 1) Tenant A sees only its own rows.
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE clearview_app');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    const seenA = await c.query<{ id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM objects',
    );
    check(
      seenA.rows.every((r) => r.tenant_id === A),
      'tenant A query returns only tenant A rows',
    );
    check(seenA.rows.some((r) => r.id === idX), 'tenant A can see its own object');
    check(!seenA.rows.some((r) => r.id === idY), 'tenant A cannot see tenant B object');
    await c.query('ROLLBACK');

    // 2) Symmetric for tenant B.
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE clearview_app');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [B]);
    const seenB = await c.query<{ id: string }>('SELECT id FROM objects');
    check(seenB.rows.some((r) => r.id === idY), 'tenant B can see its own object');
    check(!seenB.rows.some((r) => r.id === idX), 'tenant B cannot see tenant A object');
    await c.query('ROLLBACK');

    // 3) WITH CHECK blocks writing a row into another tenant.
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE clearview_app');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    try {
      await c.query(`INSERT INTO objects (tenant_id, type) VALUES ($1, 'Room')`, [B]);
      check(false, 'cross-tenant INSERT is rejected by WITH CHECK');
    } catch {
      check(true, 'cross-tenant INSERT is rejected by WITH CHECK');
    }
    await c.query('ROLLBACK');

    // 4) UPDATE of an invisible (other-tenant) row affects zero rows.
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE clearview_app');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    const upd = await c.query(`UPDATE objects SET expected_state = 'hacked' WHERE id = $1`, [idY]);
    check(upd.rowCount === 0, 'tenant A UPDATE of tenant B row affects 0 rows');
    await c.query('ROLLBACK');

    // 5) Default-deny: no tenant context → no rows visible.
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE clearview_app');
    const none = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM objects');
    check(none.rows[0]!.n === 0, 'no rows visible without a tenant context (default deny)');
    await c.query('ROLLBACK');

    // 6) events are append-only — UPDATE blocked by trigger (proven as owner).
    await c.query('BEGIN');
    const ev = await c.query<{ id: string }>(
      `INSERT INTO events (tenant_id, event_type, payload) VALUES ($1, 'test.event', '{}') RETURNING id`,
      [A],
    );
    try {
      await c.query(`UPDATE events SET actor = 'x' WHERE id = $1`, [ev.rows[0]!.id]);
      check(false, 'events UPDATE is blocked (append-only trigger)');
    } catch (err) {
      check(/append-only/.test((err as Error).message), 'events UPDATE is blocked (append-only trigger)');
    }
    await c.query('ROLLBACK');

    // 7) events are append-only — DELETE blocked by trigger.
    await c.query('BEGIN');
    const ev2 = await c.query<{ id: string }>(
      `INSERT INTO events (tenant_id, event_type) VALUES ($1, 'test.event') RETURNING id`,
      [A],
    );
    try {
      await c.query(`DELETE FROM events WHERE id = $1`, [ev2.rows[0]!.id]);
      check(false, 'events DELETE is blocked (append-only trigger)');
    } catch (err) {
      check(/append-only/.test((err as Error).message), 'events DELETE is blocked (append-only trigger)');
    }
    await c.query('ROLLBACK');

    // 8) app role has no UPDATE privilege on the verification ledger.
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE clearview_app');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
    await c.query(
      `INSERT INTO verification_ledger (tenant_id, object_id, verified_state, verification_score)
       VALUES ($1, $2, 'verified', 0.9)`,
      [A, idX],
    );
    try {
      await c.query(`UPDATE verification_ledger SET reason = 'x' WHERE object_id = $1`, [idX]);
      check(false, 'verification_ledger UPDATE is denied for the app role');
    } catch {
      check(true, 'verification_ledger UPDATE is denied for the app role');
    }
    await c.query('ROLLBACK');
  } finally {
    // cleanup: no committed events/ledger rows reference these objects.
    await c.query('DELETE FROM objects WHERE id = ANY($1::uuid[])', [[idX, idY]]);
    await c.end();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} RLS isolation: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
