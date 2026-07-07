/**
 * S1-1 integration test: exercises ObjectsRepository against $DATABASE_URL (must be
 * migrated). Proves CRUD, events-on-change, soft-delete, and cross-tenant isolation at
 * the data-access layer (every method goes through withTenant → RLS). Uses two random
 * throwaway tenants so it is independent of seed data.
 *
 * Exit 0 = all checks pass; 1 = a failure.
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
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

async function eventCount(admin: Client, objectId: string, type: string): Promise<number> {
  const res = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events WHERE object_id = $1 AND event_type = $2`,
    [objectId, type],
  );
  return res.rows[0]!.n;
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
    console.log('S1-1 object CRUD + events + isolation:');

    const created = await repo.create(A, {
      type: 'Task',
      properties: { taskType: 'room_turnover' },
      expectedState: 'ready',
    });
    check(created.type === 'Task' && created.tenantId === A, 'create returns tenant A object');
    check((await eventCount(admin, created.id, 'object.created')) === 1, 'object.created event written');

    const got = await repo.get(A, created.id);
    check(got?.id === created.id, 'tenant A can get its object');
    check((await repo.get(B, created.id)) === null, 'tenant B cannot get tenant A object');

    const updated = await repo.update(A, created.id, {
      claimedState: 'ready',
      confidence: 0.8,
      properties: { note: 'x' },
    });
    check(updated?.claimedState === 'ready' && updated?.confidence === 0.8, 'update sets state triplet');
    check(
      updated?.properties.taskType === 'room_turnover' && updated?.properties.note === 'x',
      'update shallow-merges properties',
    );
    check((await eventCount(admin, created.id, 'object.updated')) === 1, 'object.updated event written');
    check((await repo.update(B, created.id, { claimedState: 'hacked' })) === null, 'tenant B cannot update A object');

    const listA = await repo.list(A, { type: 'Task' });
    check(listA.some((o) => o.id === created.id), 'tenant A list includes object');
    const listB = await repo.list(B, { type: 'Task' });
    check(!listB.some((o) => o.id === created.id), 'tenant B list excludes A object');

    check((await repo.softDelete(A, created.id)) === true, 'soft delete succeeds');
    const archived = await repo.get(A, created.id);
    check(
      archived?.properties.archived === true && !!archived?.properties.archivedAt,
      'object flagged archived in properties',
    );
    check(archived?.verifiedState !== 'archived', 'state triplet (verified_state) left untouched');
    check(!(await repo.list(A, { type: 'Task' })).some((o) => o.id === created.id), 'default list hides archived');
    check((await repo.list(A, { type: 'Task', includeArchived: true })).some((o) => o.id === created.id), 'includeArchived shows it');
    check((await eventCount(admin, created.id, 'object.archived')) === 1, 'object.archived event written');

    const room = await repo.create(A, { type: 'Room', properties: { label: 'R1' } });
    const link = await repo.createLink(A, { fromObject: created.id, toObject: room.id, relation: 'references' });
    check(link.relation === 'references' && link.tenantId === A, 'createLink works within tenant');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} objects integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
