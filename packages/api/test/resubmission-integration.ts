/**
 * P0 · 回退重提 (Resubmission) — closed-loop step 6, against $DATABASE_URL.
 *
 * Proves the CAPPED loop + manager escalation (feat/resubmission-cap-and-ui):
 *   1. A Task is CLAIMED done but a REQUIRED evidence kind is missing → deterministic S2 returns a
 *      non-verified verdict AND an append-only `task.resubmission.requested` event is recorded
 *      (attempt 1). The first attempt's reason is preserved.
 *   2. The staff-facing /tasks/mine projection surfaces needsResubmission=true + requiredMissing +
 *      resubmissionCount + a human reason (READ-ONLY; the verdict itself still comes from S2).
 *   3. The staff resubmits and it STILL fails (attempt 2 > MAX_STAFF_RESUBMITS=1):
 *        • NO further `task.resubmission.requested` — the staff is not nagged a third time.
 *        • Exactly ONE `task.resubmission.escalated` marker is recorded (idempotent), carrying
 *          BOTH attempt reasons + requiredMissing + resubmission count.
 *        • /tasks/mine flips: needsResubmission=false, escalatedToManager=true.
 *        • Running the recommendation pipeline turns the marker into a MANAGER CUE (via the EXISTING
 *          agents.ts + persist() path) visible on the open feed, carrying both reasons + missing +
 *          count in its evidence. No new manager mechanism.
 *   4. Regression: when the resubmit SUCCEEDS (S2 → verified) the escalation must NOT fire — the loop
 *      closes, escalatedToManager=false, and the manager cue is not proposed.
 *   5. A task with no missing required evidence is never sent back. Cross-tenant isolation holds.
 *
 * Moat checks: the resubmission + escalation signals are DERIVED from events + verified_state; they
 * never write verified_state, need no migration (re-use `events`), and touch no world state. The
 * escalation cue is proposed through the normal S3 pipeline (no bespoke manager notifier).
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
import { RecommendationRepository } from '../src/recommendations/recommendation.repository';
import { RecommendationService } from '../src/recommendations/recommendation.service';
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
  const recommendations = new RecommendationService(new RecommendationRepository(), realtime);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();
  const RESUB = `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.requested'`;
  const ESC = `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.escalated'`;

  try {
    console.log('P0 resubmission — capped loop + manager escalation:');

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

    // ── 1) Attempt 1: claimed done, required snapshot missing → non-verified + resubmission event ──
    const v1 = await verification.verifyObject(A, taskId);
    check(!!v1 && v1.verifiedState !== 'verified', '1a · claimed-but-missing-evidence → S2 returns non-verified');
    check((await count(admin, RESUB, [taskId])) === 1, '1b · exactly one task.resubmission.requested event recorded');

    const ev1 = await admin.query<{ payload: { requiredMissing?: string[]; attempt?: number; reason?: string } }>(
      `SELECT payload FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.requested' ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    check((ev1.rows[0]?.payload.requiredMissing ?? []).includes('snapshot'), '1c · event names the missing evidence kind (snapshot)');
    check(ev1.rows[0]?.payload.attempt === 1, '1d · attempt counter starts at 1');
    const firstReason = ev1.rows[0]?.payload.reason ?? '';
    check(typeof firstReason === 'string' && firstReason.length > 0, '1e · first-attempt reason recorded (preserved for escalation)');

    // ── 2) Staff projection surfaces the resubmission ask (read-only) ──
    const mine1 = await tasks.listMine(A, ident(A, saId));
    check(mine1.length === 1 && mine1[0]!.taskId === taskId, '2a · task appears in the staff\'s /tasks/mine');
    check(mine1[0]!.needsResubmission === true, '2b · needsResubmission = true (within the cap)');
    check(mine1[0]!.escalatedToManager === false, '2c · escalatedToManager = false on the first bounce-back');
    check(mine1[0]!.requiredMissing.includes('snapshot'), '2d · requiredMissing surfaces the snapshot kind');
    check(mine1[0]!.resubmissionCount === 1, '2e · resubmissionCount = 1');
    check(typeof mine1[0]!.lastResubmissionReason === 'string' && mine1[0]!.lastResubmissionReason!.length > 0, '2f · a human-readable reason is present');
    check(mine1[0]!.verifiedState !== 'verified', '2g · verdict is still the S2 non-verified state (moat: read-through)');

    // ── 3) Attempt 2 STILL fails (cap = 1) → escalate to manager, do NOT nag staff again ──
    // A second failing verify represents the staff "resubmitting" without fixing the gap.
    await verification.verifyObject(A, taskId);
    check((await count(admin, RESUB, [taskId])) === 1, '3a · CAP: no second task.resubmission.requested — staff is not nagged again');
    check((await count(admin, ESC, [taskId])) === 1, '3b · exactly one task.resubmission.escalated marker recorded');

    // A third failing verify must NOT spam a second escalation marker (idempotent).
    await verification.verifyObject(A, taskId);
    check((await count(admin, RESUB, [taskId])) === 1, '3c · still no new staff bounce-back on a third failing verify');
    check((await count(admin, ESC, [taskId])) === 1, '3d · escalation marker stays singular (idempotent)');

    // The escalation marker carries the FULL history the manager needs.
    const escEv = await admin.query<{ payload: { firstReason?: string; latestReason?: string; requiredMissing?: string[]; resubmissionCount?: number } }>(
      `SELECT payload FROM events WHERE object_id = $1 AND event_type = 'task.resubmission.escalated' ORDER BY created_at DESC LIMIT 1`,
      [taskId],
    );
    const ep = escEv.rows[0]?.payload ?? {};
    check(typeof ep.firstReason === 'string' && ep.firstReason.length > 0, '3e · escalation payload preserves the FIRST-attempt reason');
    check(typeof ep.latestReason === 'string' && ep.latestReason.length > 0, '3f · escalation payload carries the LATEST-attempt reason');
    check((ep.requiredMissing ?? []).includes('snapshot'), '3g · escalation payload carries requiredMissing kinds');
    check(typeof ep.resubmissionCount === 'number' && ep.resubmissionCount >= 1, '3h · escalation payload carries the resubmission count');

    // Staff projection flips to the escalated / awaiting-manager state — no more resubmit prompt.
    const mineEsc = await tasks.listMine(A, ident(A, saId));
    check(mineEsc[0]!.escalatedToManager === true, '3i · escalatedToManager = true');
    check(mineEsc[0]!.needsResubmission === false, '3j · needsResubmission flips to FALSE (staff must not resubmit a third time)');
    check(mineEsc[0]!.resubmissionCount === 1, '3k · resubmissionCount preserved (audit trail intact)');

    // ── 4) The escalation becomes a MANAGER CUE via the EXISTING recommendation pipeline ──
    await recommendations.runForObject(A, taskId);
    const feed = await recommendations.feed(A, 'open', 25);
    const cue = feed.find((r) => r.objectId === taskId && r.sourceAgent === 'staff' && /manager review/i.test(r.title));
    check(!!cue, '4a · a manager cue for the escalated task appears on the open recommendation feed');
    const kinds = new Set((cue?.evidence ?? []).map((e) => e.kind));
    check(kinds.has('first_attempt') && kinds.has('latest_attempt'), '4b · cue evidence carries BOTH attempt reasons');
    check(kinds.has('required_missing'), '4c · cue evidence carries the still-missing evidence kinds');
    check(kinds.has('resubmission'), '4d · cue evidence carries the resubmission count');
    const missingNote = (cue?.evidence ?? []).find((e) => e.kind === 'required_missing')?.note ?? '';
    check(/snapshot/.test(missingNote), '4e · cue names snapshot as still missing');

    // ── 5) REGRESSION: when the resubmit SUCCEEDS, escalation must NOT fire; the loop closes ──
    // Fresh task in tenant A, fails once (attempt 1), then the staff attaches the snapshot → verified.
    const task2 = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,'Task',$2::jsonb,'ready') RETURNING id`,
      [A, JSON.stringify({ taskType: 'room_turnover', requiredEvidence: ['snapshot'], expectedDurationMin: 6, startedAt: '2026-07-07T10:00:00.000Z', claimedAt: '2026-07-07T10:02:00.000Z', label: 'Turnover · Room 4' })],
    );
    const t2 = task2.rows[0]!.id;
    await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,'assignedTo')`, [A, saId, t2]);
    await verification.verifyObject(A, t2); // attempt 1 → bounce-back
    check((await count(admin, RESUB, [t2])) === 1 && (await count(admin, ESC, [t2])) === 0, '5a · fresh task: one bounce-back, not yet escalated');
    const img = jpeg();
    await uploads.upload(A, { originalname: 'room4.jpg', mimetype: 'image/jpeg', size: img.length, buffer: img }, { linkTo: t2 });
    const vOk2 = await verification.verifyObject(A, t2);
    check(!!vOk2 && vOk2.verifiedState === 'verified', '5b · resubmit with snapshot → S2 flips to VERIFIED');
    check((await count(admin, ESC, [t2])) === 0, '5c · REGRESSION: escalation does NOT fire when attempt 2 passes');
    const mine2 = await tasks.listMine(A, ident(A, saId));
    const row2 = mine2.find((m) => m.taskId === t2)!;
    check(row2.needsResubmission === false && row2.escalatedToManager === false, '5d · loop closed: neither needsResubmission nor escalatedToManager');
    check(row2.verifiedState === 'verified', '5e · verdict now verified');
    // And the escalation agent proposes NO cue for a verified task.
    await recommendations.runForObject(A, t2);
    const feed2 = await recommendations.feed(A, 'open', 25);
    check(!feed2.some((r) => r.objectId === t2 && /manager review/i.test(r.title)), '5f · no manager escalation cue for the verified task');

    // ── 6) A task with NO missing required evidence is never sent back for resubmission ──
    const okTask = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,'Task',$2::jsonb,'done') RETURNING id`,
      [A, JSON.stringify({ taskType: 'freeform', expectedState: 'done', requiredEvidence: [], label: 'No-evidence task' })],
    );
    const okId = okTask.rows[0]!.id;
    const vOk = await verification.verifyObject(A, okId);
    check(!!vOk && (vOk.requiredMissing?.length ?? 0) === 0, '6a · a task with no required-evidence gap reports requiredMissing empty');
    check((await count(admin, RESUB, [okId])) === 0 && (await count(admin, ESC, [okId])) === 0, '6b · no resubmission/escalation when nothing is missing');

    // ── 7) Cross-tenant isolation: tenant B cannot see tenant A's tasks or escalation cues ──
    const SB = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Staff',$2::jsonb) RETURNING id`,
      [B, JSON.stringify({ role: 'tech', displayName: 'B · Tech' })],
    );
    check((await tasks.listMine(B, ident(B, SB.rows[0]!.id))).length === 0, '7a · tenant B sees none of tenant A\'s tasks (RLS)');
    const feedB = await recommendations.feed(B, 'open', 25);
    check(!feedB.some((r) => r.objectId === taskId || r.objectId === t2), '7b · tenant B sees none of tenant A\'s escalation cues (RLS)');
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
