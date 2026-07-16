/**
 * Command-center /overview aggregate. Builds a known fixture in its own tenant (so it is
 * independent of seed/order), then reads it through OverviewRepository — i.e. through the
 * RLS `withTenant` path — and asserts the podium tempo, type counts, low-stock count, the
 * ledger (newest-first, with mapped evidence kinds) and comms (author resolves from both a
 * string and an object). Also proves cross-tenant isolation.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { OverviewRepository } from '../src/overview/overview.repository';
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

async function insObject(
  admin: Client,
  tenant: string,
  type: string,
  properties: Record<string, unknown>,
  verified: string | null = null,
  verificationScore: number | null = null,
): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, verified_state, verification_score)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id`,
    [tenant, type, JSON.stringify(properties), verified, verificationScore],
  );
  return res.rows[0]!.id;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new OverviewRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const T = randomUUID();
  const OTHER = randomUUID();
  const past = '2000-01-01T00:00:00.000Z';

  try {
    console.log('overview aggregate:');

    await insObject(admin, T, 'Staff', { role: 'front_desk', displayName: 'A · Front Desk' });
    await insObject(admin, T, 'Room', { label: 'Room 3' }, 'conflict', 0.5);
    await insObject(admin, T, 'InventoryItem', { sku: 'CLS-500', onHand: 3, reorderPoint: 5 });
    await insObject(admin, T, 'InventoryItem', { sku: 'OK-1', onHand: 20, reorderPoint: 5 }); // healthy
    const task = await insObject(
      admin,
      T,
      'Task',
      { taskType: 'room_turnover', requiredEvidence: ['snapshot'] },
      'conflict',
      0.5,
    );
    // An overdue task: dueBy in the past and not verified.
    await insObject(admin, T, 'Task', { taskType: 'inventory_reorder', dueBy: past }, null, null);
    await insObject(admin, T, 'Recommendation', { status: 'open', title: 'Bring Room 3 to standard' });

    // Two comms: author as an object, and author as a plain string (both must resolve).
    await insObject(admin, T, 'Communication', {
      author: { handle: 'front', displayName: 'A · Front Desk' },
      text: '3号房已为下一位患者备好',
      reportType: 'task_update',
    });
    await insObject(admin, T, 'Communication', { author: 'B · Tech', text: 'plain string author' });

    // Ledger: conflict earlier, verified later → newest-first must surface the verified row.
    await admin.query(
      `INSERT INTO verification_ledger (tenant_id, object_id, verified_state, verification_score, evidence, reason, created_at)
       VALUES ($1,$2,'conflict',0.5,$3::jsonb,'missing snapshot', '2026-07-07T09:00:00Z')`,
      [T, task, JSON.stringify([{ kind: 'communication' }])],
    );
    await admin.query(
      `INSERT INTO verification_ledger (tenant_id, object_id, verified_state, verification_score, evidence, reason, created_at)
       VALUES ($1,$2,'verified',0.855,$3::jsonb,'snapshot matches SOP', '2026-07-07T09:05:00Z')`,
      [T, task, JSON.stringify([{ kind: 'communication' }, { kind: 'snapshot' }])],
    );

    const ov = await repo.overview(T);

    // counts
    check(ov.counts.Staff === 1, 'counts Staff = 1');
    check(ov.counts.Task === 2, 'counts Task = 2');
    check(ov.counts.Communication === 2, 'counts Communication = 2');
    check(ov.counts.InventoryItem === 2, 'counts InventoryItem = 2');
    check(ov.inventoryLow === 1, 'inventoryLow = 1 (only the below-reorder SKU)');

    // tempo
    check(ov.tempo.openConflicts === 2, 'tempo.openConflicts = 2 (Room + Task)');
    check(ov.tempo.overdue === 1, 'tempo.overdue = 1');
    check(ov.tempo.openRecommendations === 1, 'tempo.openRecommendations = 1');
    check(ov.tempo.score === Math.max(0, 100 - 2 * 15 - 1 * 10), 'tempo.score derived from conflicts + overdue');

    // ledger (newest first + evidence kinds)
    check(ov.ledger.length === 2, 'ledger has 2 entries');
    check(ov.ledger[0]!.verifiedState === 'verified', 'newest ledger entry is the verified one');
    check(ov.ledger[0]!.evidenceCount === 2, 'verified entry evidenceCount = 2');
    check(
      ov.ledger[0]!.evidenceKinds.includes('snapshot') && ov.ledger[0]!.evidenceKinds.includes('communication'),
      'verified entry evidenceKinds mapped (snapshot + communication)',
    );
    check(ov.ledger[0]!.title === 'room_turnover', 'ledger title falls back to taskType');

    // comms (author resolution both shapes)
    const objAuthor = ov.comms.find((c) => c.text === '3号房已为下一位患者备好');
    const strAuthor = ov.comms.find((c) => c.text === 'plain string author');
    check(objAuthor?.author === 'A · Front Desk', 'object author resolves to displayName');
    check(objAuthor?.reportType === 'task_update', 'comm carries reportType');
    check(strAuthor?.author === 'B · Tech', 'string author resolves as-is');

    // cross-tenant isolation
    const empty = await repo.overview(OTHER);
    check(
      empty.ledger.length === 0 && empty.comms.length === 0 && Object.keys(empty.counts).length === 0,
      'a different tenant sees an empty overview (RLS)',
    );
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} overview integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
