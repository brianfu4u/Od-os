/**
 * T2 · scan-to-locate resolution (embedded Postgres). Proves the read-only resolver is tenant-scoped
 * by RLS: a code resolves to an object in the caller's tenant (by UUID, by business code, by label),
 * and NEVER to another tenant's object. No writes, no verdict/claim logic touched.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { ObjectsRepository } from '../src/objects/objects.repository';
import { closePool } from '../src/database/pool';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

async function insRoom(admin: Client, tenant: string, label: string, code: string): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, expected_state) VALUES ($1,'Room',$2::jsonb,'ready') RETURNING id`,
    [tenant, JSON.stringify({ label, code })],
  );
  return res.rows[0]!.id;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new ObjectsRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('T2 scan-to-locate — resolution + tenant isolation:');

    const roomA = await insRoom(admin, A, 'Room 3', 'ROOM-3');
    await insRoom(admin, B, 'Room 3', 'ROOM-3'); // same label/code in another tenant

    // ── same-tenant resolution: by UUID, by business code, by label ──
    const byId = await repo.resolveScan(A, roomA);
    check(byId?.objectId === roomA && byId?.type === 'Room', 'A: resolves its own object by UUID');
    check(byId?.label === 'Room 3', 'A: returns a human label');

    const byCode = await repo.resolveScan(A, 'ROOM-3');
    check(byCode?.objectId === roomA, 'A: resolves by business code (properties.code)');

    const byLabel = await repo.resolveScan(A, 'Room 3');
    check(byLabel?.objectId === roomA, 'A: resolves by label');

    check((await repo.resolveScan(A, 'no-such-code')) === null, 'A: unknown code → null');
    check((await repo.resolveScan(A, '')) === null, 'A: empty code → null');

    // ── cross-tenant isolation (the security property) ──
    check((await repo.resolveScan(B, roomA)) === null, "B: cannot resolve tenant A's object by its UUID");
    const bCode = await repo.resolveScan(B, 'ROOM-3');
    check(bCode !== null && bCode.objectId !== roomA, "B: 'ROOM-3' resolves to B's OWN room, never A's");
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} scan-resolve integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
