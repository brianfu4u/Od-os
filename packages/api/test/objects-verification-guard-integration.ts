/**
 * P0-1 integration test (against $DATABASE_URL, must be migrated through 0021).
 *
 * Proves the database-level LAST LINE OF DEFENSE for the verdict invariant:
 *   (c) a plain UPDATE that changes verified_state / verification_score WITHOUT the verification
 *       session
 *       flag is rejected by the trg_objects_verdict_guard trigger, and the row is left unchanged;
 *   (d) the SAME UPDATE preceded by `SET LOCAL app.verification_write = 'true'` (exactly what the
 *       Verification Service does) succeeds — the legitimate S2 write path is NOT broken;
 *   (+) unrelated column updates (properties / claimed_state) still succeed WITHOUT the flag, so the
 *       guard is narrowly scoped to only the two verdict columns.
 *
 * The RBAC (staff → 403) and DTO-stripping guarantees are covered DB-free by
 * src/objects/objects.controller.spec.ts and packages/shared/src/api/objects.contract.test.ts.
 *
 * Exit 0 = all checks pass; 1 = a failure.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { requireDatabaseUrl } from '../db/env';
import { ObjectsRepository } from '../src/objects/objects.repository';
import { withTenant } from '../src/database/tenant-context';
import { closePool } from '../src/database/pool';

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
async function rejects(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
    failed += 1;
    console.error(`  ✗ ${label} (expected rejection)`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}

async function verdictOf(tenantId: string, id: string): Promise<{ v: string | null; c: number | null }> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ verified_state: string | null; verification_score: string | null }>(
      'SELECT verified_state, verification_score FROM objects WHERE id = $1',
      [id],
    );
    const row = r.rows[0]!;
    return {
      v: row.verified_state,
      c: row.verification_score === null ? null : Number(row.verification_score),
    };
  });
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new ObjectsRepository();
  const A = randomUUID();

  try {
    console.log('P0-1 objects verdict guard (DB trigger):');

    // A fresh object created through the generic path carries NO verdict.
    const obj = await repo.create(A, { type: 'Task', properties: { taskType: 'room_turnover' }, claimedState: 'ready' });
    const initial = await verdictOf(A, obj.id);
    check(
      initial.v === null && initial.c === null,
      'new object has NULL verified_state/verification_score (never asserted on create)',
    );

    // (c) Attack: change the verdict without the verification flag → blocked by the trigger.
    await rejects(
      withTenant(A, async (c) => {
        await c.query(
          `UPDATE objects SET verified_state = 'verified', verification_score = 1 WHERE id = $1`,
          [obj.id],
        );
      }),
      'raw UPDATE of verified_state/verification_score WITHOUT the flag is rejected by the DB trigger',
    );
    const afterAttack = await verdictOf(A, obj.id);
    check(afterAttack.v === null && afterAttack.c === null, 'verdict unchanged after the blocked attempt (tx rolled back)');

    // (+) Narrow scope: unrelated column updates still work without the flag.
    const okUpdate = await repo.update(A, obj.id, { claimedState: 'done', properties: { note: 'progress' } });
    check(okUpdate?.claimedState === 'done', 'non-verdict UPDATE (claimed_state/properties) succeeds without the flag');
    const afterOk = await verdictOf(A, obj.id);
    check(afterOk.v === null && afterOk.c === null, 'the non-verdict UPDATE did not touch the verdict');

    // (d) Legitimate S2 write path: same UPDATE, but with the session flag set → succeeds.
    await withTenant(A, async (c) => {
      await c.query(`SET LOCAL app.verification_write = 'true'`);
      await c.query(
        `UPDATE objects SET verified_state = 'verified', verification_score = 0.9 WHERE id = $1`,
        [obj.id],
      );
    });
    const afterVerify = await verdictOf(A, obj.id);
    check(
      afterVerify.v === 'verified' && afterVerify.c === 0.9,
      'UPDATE WITH the verification flag succeeds (S2 path intact)',
    );

    // The flag must not leak: a later UNflagged verdict change is blocked again.
    await rejects(
      withTenant(A, async (c) => {
        await c.query(`UPDATE objects SET verification_score = 0.1 WHERE id = $1`, [obj.id]);
      }),
      'flag does not leak across transactions — next unflagged verdict change is blocked',
    );

    console.log(`\n${failed === 0 ? '✔' : '✖'} P0-1 verdict guard — ${passed} passed, ${failed} failed.`);
  } finally {
    await closePool();
  }

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
