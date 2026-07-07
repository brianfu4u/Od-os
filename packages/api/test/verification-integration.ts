/**
 * S2 integration test: the cross-verification engine against $DATABASE_URL, including the
 * structure-design §4 Room-3 story end to end — claim-only + missing snapshot + timing
 * anomaly → CONFLICT @0.76; snapshot uploaded (auto re-score via the evidence hook) →
 * VERIFIED @0.93; TWO ledger rows; Alert raised; cross-tenant isolation; overdue sweep.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { RealtimeService } from '../src/objects/realtime.service';
import { DeterministicScorer } from '../src/verification/scorer';
import { VerificationRepository } from '../src/verification/verification.repository';
import { VerificationService } from '../src/verification/verification.service';
import { UploadsRepository } from '../src/uploads/uploads.repository';
import { UploadsService } from '../src/uploads/uploads.service';
import { LocalDiskStorageProvider } from '../src/storage/local-disk.provider';
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
async function count(admin: Client, sql: string, p: unknown[]): Promise<number> {
  return (await admin.query<{ n: number }>(sql, p)).rows[0]!.n;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const realtime = new RealtimeService();
  const verification = new VerificationService(new DeterministicScorer(), new VerificationRepository(), realtime);
  const uploads = new UploadsService(
    new LocalDiskStorageProvider(`/tmp/od-verif-test-${randomUUID()}`),
    new UploadsRepository(),
    realtime,
    verification, // the evidence hook → auto re-score on upload
  );
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('S2 cross-verification (Room 3 §4):');

    // Room-3 turnover: claimed ready, but started only 2 min ago (SOP 6 min) and snapshot missing.
    const task = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties, claimed_state)
       VALUES ($1, 'Task', $2::jsonb, 'ready') RETURNING id`,
      [
        A,
        JSON.stringify({
          taskType: 'room_turnover',
          requiredEvidence: ['snapshot'],
          expectedDurationMin: 6,
          startedAt: '2026-07-07T09:18:00.000Z',
          claimedAt: '2026-07-07T09:20:00.000Z',
          label: 'Room 3',
        }),
      ],
    );
    const taskId = task.rows[0]!.id;

    // Step 1 — verify with only the claim.
    const r1 = await verification.verifyObject(A, taskId);
    check(r1?.verifiedState === 'conflict', 'claim-only + missing snapshot + timing anomaly → conflict');
    check(!!r1 && Math.abs(r1.confidence - 0.76) < 0.01, `confidence ≈ 0.76 (got ${r1?.confidence})`);
    const afterVerify1 = await admin.query<{ verified_state: string }>('SELECT verified_state FROM objects WHERE id=$1', [taskId]);
    check(afterVerify1.rows[0]!.verified_state === 'conflict', 'object.verified_state = conflict');
    check((await count(admin, `SELECT count(*)::int AS n FROM verification_ledger WHERE object_id=$1`, [taskId])) === 1, 'ledger row #1 appended');
    check((await count(admin, `SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND event_type='object.state.verified'`, [taskId])) === 1, 'object.state.verified emitted');
    check((await count(admin, `SELECT count(*)::int AS n FROM objects WHERE type='Alert' AND properties->>'objectId'=$1`, [taskId])) === 1, 'conflict Alert raised');

    // Step 2 — upload the turnover snapshot linked to the task → auto re-score.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    await uploads.upload(A, { originalname: 'room3.png', mimetype: 'image/png', size: png.length, buffer: png }, { linkTo: taskId });

    const afterVerify2 = await admin.query<{ verified_state: string; confidence: string | null }>(
      'SELECT verified_state, confidence FROM objects WHERE id=$1',
      [taskId],
    );
    check(afterVerify2.rows[0]!.verified_state === 'verified', 'after snapshot upload → verified (auto re-score)');
    check(Math.abs(Number(afterVerify2.rows[0]!.confidence) - 0.93) < 0.01, `confidence ≈ 0.93 (got ${afterVerify2.rows[0]!.confidence})`);
    check((await count(admin, `SELECT count(*)::int AS n FROM verification_ledger WHERE object_id=$1`, [taskId])) === 2, 'ledger row #2 appended (immutable history)');
    check((await count(admin, `SELECT count(*)::int AS n FROM links l JOIN objects o ON o.id=l.from_object WHERE l.to_object=$1 AND o.type='Snapshot'`, [taskId])) === 1, 'snapshot linked to the task');

    // Step 3 — cross-tenant isolation.
    check((await verification.verifyObject(B, taskId)) === null, 'tenant B cannot verify tenant A object (RLS)');

    // Step 4 — overdue sweep raises an alert.
    const overdue = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties, claimed_state)
       VALUES ($1, 'Task', $2::jsonb, 'ready') RETURNING id`,
      [A, JSON.stringify({ taskType: 'room_turnover', requiredEvidence: ['snapshot'], dueBy: '2020-01-01T00:00:00.000Z' })],
    );
    const overdueId = overdue.rows[0]!.id;
    const swept = await verification.sweep(A);
    check(swept.swept >= 1, 'sweep processed non-verified tasks');
    const overdueAlert = await admin.query<{ properties: Record<string, unknown> }>(
      `SELECT properties FROM objects WHERE type='Alert' AND properties->>'objectId'=$1 ORDER BY created_at DESC LIMIT 1`,
      [overdueId],
    );
    const triggered = (overdueAlert.rows[0]?.properties.triggered ?? []) as string[];
    check(triggered.includes('overdue'), 'overdue Alert raised by sweep');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} verification integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
