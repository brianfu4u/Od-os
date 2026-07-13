/**
 * P0 · 回退重提 (Resubmission) — closed-loop step 6, against $DATABASE_URL.
 *
 * Proves the full loop:
 *   1. A Task is CLAIMED done but a REQUIRED evidence kind is missing → deterministic S2 returns a
 *      non-verified verdict AND an append-only `task.resubmission.requested` event is recorded.
 *   2. The staff-facing /tasks/mine projection surfaces needsResubmission=true + requiredMissing +
 *      resubmissionCount + a human reason (READ-ONLY; the verdict itself still comes from S2).
 *   3. The staff adds the missing evidence (snapshot upload → auto re-verify) → verdict flips to
 *      VERIFIED → NO new resubmission event → needsResubmission flips back to false while the audit
 *      trail (count) is preserved. The loop CLOSES.
 *   4. verified tasks never emit a resubmission event; cross-tenant isolation holds.
 *
 * Moat checks: the resubmission signal is DERIVED from events + verified_state; it never writes
 * verified_state, needs no migration (re-uses `events`), and touches no world state.
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
import { TasksRepository } from '../src/tasks/tasks.repository';
import { closePool } from '../src/database/pool';
import type { SessionIdentity } from '../src/auth/session.types';

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
  return Number((await admin.query<{ n: string }>(sql, p)).rows[0]!.n);
}
const ident = (tenantId: string, staffId: string): SessionIdentity => ({ subject: 'staff', tenantId, staffId });
/** Minimal valid JPEG (SOI + EXIF + SOS + EOI) so the uploader classifies it as a Snapshot. */
function jpeg(): Buffer {
  const seg = (m: number, pl: Buffer) => Buffer.concat([Buffer.from([0xff, m, ((pl.length + 2) >> 8) & 0xff, (pl.length + 2) & 0xff]), pl]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe1, Buffer.from('Exif\x00\x00room3', 'binary')),
    Buffer.from([0xff, 0xda, 0x00, 0x03, 0x01, 0x11, 0x22, 0x33]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const realtime = new RealtimeService();
  const verification = new VerificationService(new DeterministicScorer(), new VerificationRepository(), realtime);
  const uploads = new UploadsService(
    new LocalDiskStorageProvider(`/tmp/od-resub-test-${randomUUID()}`),
    new UploadsRepository(),
    realtime,
    verification, // evidence hook → auto re-verify on upload
  );
  const tasks = new TasksRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();
  const RESUB = `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.requested'`;

  try {
    console.log('P0 resubmission — closed-loop step 6:');

    // ── Setup: staff SA in tenant A owns a room_turnover task, CLAIMED ready but snapshot missing ──
    const SA = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Staff',$2::jsonb) RETURNING id`,
      [A, JSON.stringify({ role: 'tech', displayName: 'A · Tech', staffHandle: 'a_tech' })],
    );
    const saId = SA.rows[0]!.id;
    const task = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,'Task',$2::jsonb,'ready') RETURNING id`,
      [
        A,
        JSON.stringify({
          taskType: 'room_turnover',
          requiredEvidence: ['snapshot'],
          expectedDurationMin: 6,
          startedAt: '2026-07-07T09:18:00.000Z',
          claimedAt: '2026-07-07T09:20:00.000Z',
          label: 'Turnover · Room 3',
        }),
      ],
    );
    const taskId = task.rows[0]!.id;
    await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,'assignedTo')`, [A, saId, taskId]);

    // ── 1) First verify: claimed done, required snapshot missing → non-verified + resubmission event ──
    const v1 = await verification.verifyObject(A, taskId);
    check(!!v1 && v1.verifiedState !== 'verified', '1a · claimed-but-missing-evidence → S2 returns non-verified');
    check((await count(admin, RESUB, [taskId])) === 1, '1b · exactly one task.resubmission.requested event recorded');

    // resubmission event carries the actionable detail (missing kinds + attempt counter)
    const ev1 = await admin.query<{ payload: { requiredMissing?: string[]; attempt?: number; verifiedState?: string } }>(
      `SELECT payload FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.requested' ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    check((ev1.rows[0]?.payload.requiredMissing ?? []).includes('snapshot'), '1c · event names the missing evidence kind (snapshot)');
    check(ev1.rows[0]?.payload.attempt === 1, '1d · attempt counter starts at 1');

    // ── 2) Staff projection surfaces the resubmission ask (read-only) ──
    const mine1 = await tasks.listMine(A, ident(A, saId));
    check(mine1.length === 1 && mine1[0]!.taskId === taskId, '2a · task appears in the staff\'s /tasks/mine');
    check(mine1[0]!.needsResubmission === true, '2b · needsResubmission = true');
    check(mine1[0]!.requiredMissing.includes('snapshot'), '2c · requiredMissing surfaces the snapshot kind');
    check(mine1[0]!.resubmissionCount === 1, '2d · resubmissionCount = 1');
    check(typeof mine1[0]!.lastResubmissionReason === 'string' && mine1[0]!.lastResubmissionReason!.length > 0, '2e · a human-readable reason is present');
    check(mine1[0]!.verifiedState !== 'verified', '2f · verdict is still the S2 non-verified state (moat: read-through)');

    // ── 2.5) A second failing verify increments the attempt counter (still not satisfied) ──
    await verification.verifyObject(A, taskId);
    check((await count(admin, RESUB, [taskId])) === 2, '2.5a · repeated failing verify → second resubmission event (attempt tracked)');
    const mine1b = await tasks.listMine(A, ident(A, saId));
    check(mine1b[0]!.resubmissionCount === 2 && mine1b[0]!.needsResubmission === true, '2.5b · projection reflects attempt=2, still needs resubmission');

    // ── 3) Staff resubmits: uploads the missing snapshot → auto re-verify → verdict closes to verified ──
    const beforeVerified = await count(admin, RESUB, [taskId]);
    const img = jpeg();
    // Single-step upload with linkTo → creates a Snapshot evidence object linked to the task AND
    // fires the verification hook (auto re-verify). This is exactly how the staff console resubmits.
    await uploads.upload(
      A,
      { originalname: 'room3.jpg', mimetype: 'image/jpeg', size: img.length, buffer: img },
      { linkTo: taskId },
    );

    const vFinal = await verification.verifyObject(A, taskId);
    check(!!vFinal && vFinal.verifiedState === 'verified', '3a · with the snapshot attached, S2 flips the task to VERIFIED');
    check((await count(admin, RESUB, [taskId])) === beforeVerified, '3b · a satisfied (verified) verify records NO new resubmission event — the loop stops');

    const mine2 = await tasks.listMine(A, ident(A, saId));
    check(mine2[0]!.needsResubmission === false, '3c · needsResubmission flips back to false (loop closed)');
    check(mine2[0]!.requiredMissing.length === 0, '3d · requiredMissing cleared once verified');
    check(mine2[0]!.resubmissionCount === beforeVerified, '3e · resubmissionCount preserved as audit history (not erased)');
    check(mine2[0]!.verifiedState === 'verified', '3f · verdict now verified');

    // ── 4) A task with NO missing required evidence is never sent back for resubmission ──
    // (It may still be `pending` on self-claim alone — the moat: a lone self-claim never reaches
    // verified — but the shortfall is NOT staff-actionable via evidence, so no resubmission ask.)
    const okTask = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,'Task',$2::jsonb,'done') RETURNING id`,
      [A, JSON.stringify({ taskType: 'freeform', expectedState: 'done', requiredEvidence: [], label: 'No-evidence task' })],
    );
    const okId = okTask.rows[0]!.id;
    const vOk = await verification.verifyObject(A, okId);
    check(!!vOk && (vOk.requiredMissing?.length ?? 0) === 0, '4a · a task with no required-evidence gap reports requiredMissing empty');
    check((await count(admin, RESUB, [okId])) === 0, '4b · no resubmission event when nothing is missing (not staff-actionable)');

    // ── 5) Cross-tenant isolation: tenant B cannot see tenant A's resubmission projection ──
    const SB = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Staff',$2::jsonb) RETURNING id`,
      [B, JSON.stringify({ role: 'tech', displayName: 'B · Tech' })],
    );
    check((await tasks.listMine(B, ident(B, SB.rows[0]!.id))).length === 0, '5 · tenant B sees none of tenant A\'s tasks (RLS)');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} resubmission integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
