/**
 * feat/demo-seed integration (against $DATABASE_URL). Proves the synthetic seed:
 *  - derives EVERY verdict via the REAL S2 engine, matching the intended color
 *    (verified/conflict/pending/unverified) — the seed writes claims/evidence only;
 *  - is idempotent: a second run adds no duplicate objects and re-verifies nothing (all skipped);
 *  - is tenant-scoped: a different tenant sees zero demo objects (RLS);
 *  - never wrote verified_state itself — the verification_ledger has S2-written rows (seed writes none);
 *  - reset ARCHIVES this tenant's demo data (never truncates — the rows still exist, just archived).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { withTenant } from '../src/database/tenant-context';
import { closePool } from '../src/database/pool';
import { runDemoSeed, archiveDemoData } from '../src/demo/demo-runner';

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

function countDemoTasks(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (c: PoolClient) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM objects WHERE type = 'Task' AND (properties->>'seedKey') LIKE 'demo:%'`,
    );
    return r.rows[0]?.n ?? 0;
  });
}
function countActiveDemoObjects(tenantId: string): Promise<number> {
  return withTenant(tenantId, async (c: PoolClient) => {
    const r = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM objects WHERE (properties->>'seedKey') LIKE 'demo:%' AND (properties->>'archived') IS DISTINCT FROM 'true'`,
    );
    return r.rows[0]?.n ?? 0;
  });
}
function ledgerRowsFor(tenantId: string, objectId: string): Promise<number> {
  return withTenant(tenantId, async (c: PoolClient) => {
    const r = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM verification_ledger WHERE object_id = $1`, [objectId]);
    return r.rows[0]?.n ?? 0;
  });
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('feat/demo-seed:');

    // 1) First run: S2 derives every verdict as designed.
    const run1 = await runDemoSeed(A);
    check(run1.seeded >= 8, `seeded objects (${run1.seeded})`);
    check(
      run1.verdicts.every((v) => v.got === v.target),
      'S2 derived every verdict to its intended color',
    );
    for (const color of ['verified', 'conflict', 'pending', 'unverified']) {
      check((run1.tally[color] ?? 0) >= 1, `verdict color present: ${color}`);
    }
    check(run1.verdicts.every((v) => !v.skipped), 'first run verified every task (none skipped)');

    // 2) Moat: S2 wrote the ledger (the seed writes none). Conflict task must have a ledger row.
    const conflict = run1.verdicts.find((v) => v.target === 'conflict')!;
    const conflictId = run1.ids.get(conflict.seedKey)!;
    check((await ledgerRowsFor(A, conflictId)) >= 1, 'S2 wrote a verification_ledger row for the conflict task');

    // 3) Idempotent: second run adds no duplicate tasks and re-verifies nothing.
    const tasks1 = await countDemoTasks(A);
    const run2 = await runDemoSeed(A);
    const tasks2 = await countDemoTasks(A);
    check(tasks2 === tasks1, `no duplicate tasks on re-run (${tasks1} → ${tasks2})`);
    check(run2.verdicts.every((v) => v.skipped), 'second run skipped re-verification (idempotent)');

    // 4) Tenant isolation: tenant B has no demo objects.
    check((await countDemoTasks(B)) === 0, 'tenant B sees zero demo tasks (RLS)');

    // 5) Reset ARCHIVES (never truncates): active demo objects → 0, but rows still exist.
    await archiveDemoData(A);
    check((await countActiveDemoObjects(A)) === 0, 'reset archived all demo objects (none active)');
    check((await countDemoTasks(A)) === tasks1, 'reset did NOT delete rows (tasks still present, just archived)');
  } finally {
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} demo-seed integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
