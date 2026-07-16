/**
 * LLM1 · Listen layer end-to-end (embedded Postgres).
 *
 * Part A — MOAT ISOLATION: with NO verification engine listening, LLM1 analyzing "3号房已备好" sets
 *   the Task's claimed_state='ready' but leaves verified_state NULL. Proof that LLM1 writes claims,
 *   never verdicts.
 * Part B — FULL DoD LOOP: a report flows through ReportsService → report.received → LLM1 (heuristic)
 *   → claimed_state='ready' → deterministic cross-verification → conflict @0.50; after a snapshot is
 *   attached, re-verify → verified @0.855. Plus: a ranked cue is produced, the analysis is audited,
 *   and the Communication is annotated.
 * Part C — TENANT ISOLATION: another tenant sees none of LLM1's analyses.
 *
 * Uses the deterministic HeuristicListener so it runs keyless and reproducibly (no DeepSeek).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { RealtimeService } from '../src/objects/realtime.service';
import { DomainEventBus } from '../src/events/domain-event-bus';
import { ObjectsRepository } from '../src/objects/objects.repository';
import { ObjectsService } from '../src/objects/objects.service';
import { DeterministicScorer } from '../src/verification/scorer';
import { VerificationRepository } from '../src/verification/verification.repository';
import { VerificationService } from '../src/verification/verification.service';
import { RecommendationRepository } from '../src/recommendations/recommendation.repository';
import { RecommendationService } from '../src/recommendations/recommendation.service';
import { ReportsRepository } from '../src/reports/reports.repository';
import { ReportsService } from '../src/reports/reports.service';
import { LlmListenerRepository } from '../src/listener/listener.repository';
import { SensitivePayloadsRepository } from '../src/retention/sensitive-payloads.repository';
import { HeuristicListener } from '../src/listener/heuristic-listener';
import { LlmListenerService } from '../src/listener/listener.service';
import { closePool } from '../src/database/pool';
import type { SessionIdentity } from '../src/auth/session.types';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}
const near = (a: number | null | undefined, b: number, tol = 0.02) => a != null && Math.abs(Number(a) - b) <= tol;

async function insRoomAndTurnover(admin: Client, tenant: string): Promise<{ roomId: string; taskId: string }> {
  const room = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, expected_state) VALUES ($1,'Room',$2::jsonb,'ready') RETURNING id`,
    [tenant, JSON.stringify({ label: 'Room 3' })],
  );
  const roomId = room.rows[0]!.id;
  // In-progress turnover: started 2 min ago, no claim yet, no snapshot. A "ready" claim now is
  // suspiciously fast (SOP 6 min) → the deterministic engine will call it a conflict.
  const startedAt = new Date(Date.now() - 2 * 60000).toISOString();
  const task = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, expected_state) VALUES ($1,'Task',$2::jsonb,'ready') RETURNING id`,
    [tenant, JSON.stringify({ taskType: 'room_turnover', requiredEvidence: ['snapshot'], expectedDurationMin: 6, startedAt })],
  );
  const taskId = task.rows[0]!.id;
  await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,'references')`, [tenant, taskId, roomId]);
  return { roomId, taskId };
}

async function readObj(admin: Client, id: string) {
  const r = await admin.query<{ claimed_state: string | null; verified_state: string | null; verification_score: string | null; properties: Record<string, unknown> }>(
    `SELECT claimed_state, verified_state, verification_score, properties FROM objects WHERE id=$1`,
    [id],
  );
  return r.rows[0]!;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const realtime = new RealtimeService();
  const listenRepo = new LlmListenerRepository(new SensitivePayloadsRepository());
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const C = randomUUID();
  const B = randomUUID();

  try {
    console.log('LLM1 listen layer — moat + DoD loop:');

    // ── Part A: MOAT ISOLATION (no verification subscriber) ──────────────────────────────
    const busA = new DomainEventBus();
    const objectsA = new ObjectsService(new ObjectsRepository(), realtime, busA);
    const listenerA = new LlmListenerService(new HeuristicListener(), listenRepo, objectsA, undefined, busA);
    const { taskId: taskA } = await insRoomAndTurnover(admin, A);
    const commA = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Communication',$2::jsonb) RETURNING id`,
      [A, JSON.stringify({ text: '3号房已备好', reportType: 'event', locale: 'zh' })],
    );
    const analysisA = await listenerA.process(A, commA.rows[0]!.id);
    check(analysisA?.claim?.taskType === 'room_turnover', 'A: heuristic extracted a room_turnover claim');
    const afterA = await readObj(admin, taskA);
    check(afterA.claimed_state === 'ready', 'A: LLM1 wrote claimed_state=ready');
    check(afterA.verified_state === null, 'A: LLM1 did NOT write verified_state (moat holds with no verifier listening)');
    const commProps = (await readObj(admin, commA.rows[0]!.id)).properties as { llm?: { classification?: { domain?: string; taskType?: string } } };
    check(commProps.llm?.classification?.domain === 'patient_flow', 'A: Communication annotated (patient_flow / room_turnover)');
    const logA = await admin.query<{ applied_action: string; claimed_state: string | null }>(
      `SELECT applied_action, claimed_state FROM llm_analysis_log WHERE tenant_id=$1 AND object_id=$2`,
      [A, taskA],
    );
    check(logA.rows[0]?.applied_action === 'claim_applied' && logA.rows[0]?.claimed_state === 'ready', 'A: audit row recorded claim_applied');

    // ── Part B: FULL DoD LOOP (report → claim → conflict → snapshot → verified) ───────────
    const busB = new DomainEventBus();
    const verification = new VerificationService(new DeterministicScorer(), new VerificationRepository(), realtime, busB);
    const recommendations = new RecommendationService(new RecommendationRepository(), realtime, busB);
    const objectsB = new ObjectsService(new ObjectsRepository(), realtime, busB);
    const listenerB = new LlmListenerService(new HeuristicListener(), listenRepo, objectsB, recommendations, busB);
    const reports = new ReportsService(new ReportsRepository(), realtime, verification, busB);
    const { taskId: taskC } = await insRoomAndTurnover(admin, C);

    const identity: SessionIdentity = { subject: 'staff', tenantId: C, staffHandle: 'nurse-a', staffDisplayName: 'Nurse A' } as SessionIdentity;
    await reports.ingest(C, { clientMessageId: randomUUID(), reportType: 'event', text: '3号房已备好' }, identity);
    await listenerB.idle(); // await the async LLM1 processing kicked off by report.received

    const afterClaim = await readObj(admin, taskC);
    check(afterClaim.claimed_state === 'ready', 'B: report → LLM1 set claimed_state=ready');
    check(afterClaim.verified_state === 'conflict', 'B: deterministic engine returned CONFLICT (too-fast + missing snapshot)');
    check(near(afterClaim.verification_score, 0.5), `B: conflict verification_score ≈ 0.50 (got ${afterClaim.verification_score})`);

    const ledger = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM verification_ledger WHERE object_id=$1`, [taskC]);
    check((ledger.rows[0]?.n ?? 0) >= 1, 'B: verification_ledger row written by the deterministic engine (not LLM1)');
    const cue = (await recommendations.feed(C, 'open', 20)).find((r) => r.objectId === taskC);
    check(!!cue && cue.domain === 'patient_flow', 'B: a ranked patient-flow cue was produced from the conflict');
    const logB = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM llm_analysis_log WHERE tenant_id=$1 AND applied_action='claim_applied'`, [C]);
    check((logB.rows[0]?.n ?? 0) === 1, 'B: LLM1 analysis audited (claim_applied)');

    // Attach the required snapshot → re-verify → verified @0.855.
    const snap = await admin.query<{ id: string }>(`INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Snapshot','{}'::jsonb) RETURNING id`, [C]);
    await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,'references')`, [C, snap.rows[0]!.id, taskC]);
    const reVerified = await verification.verifyObject(C, taskC);
    check(reVerified?.verifiedState === 'verified', 'B: snapshot attached → re-verify → VERIFIED');
    check(near(reVerified?.verificationScore ?? 0, 0.855), `B: verified verificationScore ≈ 0.855 (got ${reVerified?.verificationScore})`);

    // ── Part C: TENANT ISOLATION ──────────────────────────────────────────────────────────
    const sumB = await listenerB.summarize(B, { hours: 24 });
    check(sumB.count === 0, 'C: an untouched tenant sees zero LLM1 analyses (RLS isolation)');
    const sumC = await listenerB.summarize(C, { hours: 24 });
    check(sumC.count >= 1 && sumC.text.length > 0, 'C: the active tenant gets a non-empty summary');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} listener integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
