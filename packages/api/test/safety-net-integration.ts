/**
 * P3.1 safety-net regressions (audit follow-ups):
 *   ① Under the runtime path (withTenant → SET ROLE clearview_app), the non-RLS auth tables
 *      (sessions / staff_identities / manager_identities) are UNREADABLE — clearview_app has no
 *      grant on them; only the base login role does. So a tenant-scoped business query can never
 *      reach session/identity data.
 *   ② GET /objects/:id/timeline is tenant-isolated: tenant B cannot read tenant A's object story.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { withTenant } from '../src/database/tenant-context';
import { ObjectsRepository } from '../src/objects/objects.repository';
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
async function expectThrow(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    check(false, label);
  } catch {
    check(true, label);
  }
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const objects = new ObjectsRepository();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('P3.1 safety net:');

    // ① Auth tables are invisible to the RLS-restricted app role (the only role a request runs as).
    for (const table of ['sessions', 'staff_identities', 'manager_identities']) {
      await expectThrow(
        () => withTenant(A, (c) => c.query(`SELECT 1 FROM ${table} LIMIT 1`)),
        `clearview_app cannot read ${table} (permission denied under withTenant)`,
      );
    }
    // Sanity: it CAN read business tables under the same role.
    const ok = await withTenant(A, (c) => c.query(`SELECT count(*)::int AS n FROM objects`));
    check(typeof (ok.rows[0] as { n: number }).n === 'number', 'clearview_app CAN read the tenant-scoped objects table');

    // ② Timeline is tenant-isolated.
    const objId = (
      await admin.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties, claimed_state, verified_state, confidence)
         VALUES ($1, 'Task', $2::jsonb, 'ready', 'conflict', 0.5) RETURNING id`,
        [A, JSON.stringify({ taskType: 'room_turnover', label: 'Room 3' })],
      )
    ).rows[0]!.id;
    await admin.query(
      `INSERT INTO events (tenant_id, object_id, event_type, payload, actor) VALUES ($1, $2, 'object.created', '{}'::jsonb, 'system')`,
      [A, objId],
    );
    await admin.query(
      `INSERT INTO verification_ledger (tenant_id, object_id, verified_state, confidence, evidence, reason)
       VALUES ($1, $2, 'conflict', 0.5, '[]'::jsonb, 'seeded')`,
      [A, objId],
    );

    const ownerView = await objects.timeline(A, objId);
    check(ownerView.object?.id === objId, 'tenant A sees its own object timeline');
    check(ownerView.events.length >= 1 && ownerView.ledger.length >= 1, 'owner timeline carries events + ledger');

    const crossView = await objects.timeline(B, objId);
    check(crossView.object === null, 'tenant B cannot read tenant A object via timeline (RLS → null)');
    check(crossView.events.length === 0 && crossView.ledger.length === 0, 'tenant B sees no events/ledger for tenant A object');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} safety-net integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
