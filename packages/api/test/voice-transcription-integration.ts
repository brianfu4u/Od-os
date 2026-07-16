/**
 * P7 · T4 Speech-to-Text end-to-end (embedded Postgres). Uses the deterministic MockTranscriber
 * (no network) + the HeuristicListener (no DeepSeek), so it runs keyless and reproducibly in CI.
 *
 * Part A — MOAT ISOLATION: with NO verification engine listening, transcribing a voice clip whose
 *   transcript is "3号房已备好" stores the transcript on the voice Document, feeds LLM1, sets the
 *   Task's claimed_state='ready', and leaves verified_state NULL. Proof STT/LLM produce claims,
 *   never verdicts. Original audio (storageKey) is retained; an append-only log row is written.
 * Part B — FULL DoD LOOP: with the deterministic engine listening, the SAME transcript flows
 *   voice → transcript → LLM1 → claimed_state='ready' → cross-verification → conflict @0.50; after a
 *   snapshot is attached, re-verify → verified @0.855. The transcript drove the whole pipeline.
 * Part C — APPEND-ONLY + TENANT ISOLATION: UPDATE on transcription_log is rejected (forbid_mutation),
 *   and a different tenant sees none of these transcriptions.
 * Part D — SCOPED FEED (P7/T4-web follow-up): the read-only listVoiceFeed returns only the tenant's
 *   voice docs joined to each transcript's Task verdict, and is RLS-isolated across tenants.
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
import { LlmListenerRepository } from '../src/listener/listener.repository';
import { HeuristicListener } from '../src/listener/heuristic-listener';
import { LlmListenerService } from '../src/listener/listener.service';
import { TranscriptionRepository } from '../src/transcription/transcription.repository';
import { TranscriptionService } from '../src/transcription/transcription.service';
import { MockTranscriber } from '../src/transcription/mock.transcriber';
import type { TranscriptionResult } from '../src/transcription/transcription.types';
import type { StoragePort } from '../src/storage/storage.provider';
import { closePool } from '../src/database/pool';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}
const near = (a: number | null | undefined, b: number, tol = 0.02) => a != null && Math.abs(Number(a) - b) <= tol;

// A fake storage that returns synthetic bytes (the MockTranscriber ignores them) — no disk I/O.
const storage = {
  read: async () => Buffer.from('SYNTHETIC_AUDIO'),
  put: async () => undefined,
  getSignedUrl: async () => ({ url: '', expiresAt: '' }),
  head: async () => ({ exists: true, size: 1 }),
} as unknown as StoragePort;

const CANNED: TranscriptionResult = { status: 'done', text: '3号房已备好', language: 'zh', confidence: 0.9, provider: 'mock', model: 'mock' };

async function insRoomAndTurnover(admin: Client, tenant: string): Promise<{ roomId: string; taskId: string }> {
  const room = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, expected_state) VALUES ($1,'Room',$2::jsonb,'ready') RETURNING id`,
    [tenant, JSON.stringify({ label: 'Room 3' })],
  );
  const roomId = room.rows[0]!.id;
  const startedAt = new Date(Date.now() - 2 * 60000).toISOString();
  const task = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, expected_state) VALUES ($1,'Task',$2::jsonb,'ready') RETURNING id`,
    [tenant, JSON.stringify({ taskType: 'room_turnover', requiredEvidence: ['snapshot'], expectedDurationMin: 6, startedAt })],
  );
  const taskId = task.rows[0]!.id;
  await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,'references')`, [tenant, taskId, roomId]);
  return { roomId, taskId };
}

async function insVoiceDoc(admin: Client, tenant: string): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Document',$2::jsonb) RETURNING id`,
    [tenant, JSON.stringify({ kind: 'voice', mime: 'audio/m4a', storageKey: `tenant/${tenant}/${randomUUID()}.m4a`, locale: 'zh' })],
  );
  return res.rows[0]!.id;
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
  const listenRepo = new LlmListenerRepository();
  const transcriptionRepo = new TranscriptionRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const C = randomUUID();
  const B = randomUUID();

  try {
    console.log('T4 speech-to-text — moat + DoD loop + scoped feed:');

    // ── Part A: MOAT ISOLATION (no verification subscriber) ──────────────────────────────
    const busA = new DomainEventBus();
    const objectsA = new ObjectsService(new ObjectsRepository(), realtime, busA);
    const listenerA = new LlmListenerService(new HeuristicListener(), listenRepo, objectsA, undefined, busA);
    const transcriptionA = new TranscriptionService(new MockTranscriber(CANNED), storage, transcriptionRepo, objectsA, listenerA);
    const { taskId: taskA } = await insRoomAndTurnover(admin, A);
    const voiceA = await insVoiceDoc(admin, A);

    const statusA = await transcriptionA.transcribe(A, voiceA);
    check(statusA === 'done', 'A: transcription completed (done)');

    const voiceDocA = await readObj(admin, voiceA);
    const transcriptA = voiceDocA.properties.transcript as { text?: string; status?: string } | undefined;
    check(transcriptA?.status === 'done' && transcriptA?.text === '3号房已备好', 'A: transcript stored as a derived field on the voice Document');
    check((voiceDocA.properties as { storageKey?: string }).storageKey?.includes('.m4a') === true, 'A: original audio (storageKey) retained after transcription');

    const afterA = await readObj(admin, taskA);
    check(afterA.claimed_state === 'ready', 'A: transcript → LLM1 set claimed_state=ready on the Task');
    check(afterA.verified_state === null, 'A: STT/LLM did NOT write verified_state (moat holds with no verifier listening)');

    const logA = await admin.query<{ status: string; provider: string }>(
      `SELECT status, provider FROM transcription_log WHERE tenant_id=$1 AND object_id=$2`,
      [A, voiceA],
    );
    check(logA.rows[0]?.status === 'done' && logA.rows[0]?.provider === 'mock', 'A: append-only transcription_log row recorded (done / mock)');

    // ── Part B: FULL DoD LOOP (voice → transcript → claim → conflict → snapshot → verified) ─
    const busB = new DomainEventBus();
    const verification = new VerificationService(new DeterministicScorer(), new VerificationRepository(), realtime, busB);
    const recommendations = new RecommendationService(new RecommendationRepository(), realtime, busB);
    const objectsB = new ObjectsService(new ObjectsRepository(), realtime, busB);
    const listenerB = new LlmListenerService(new HeuristicListener(), listenRepo, objectsB, recommendations, busB);
    const transcriptionB = new TranscriptionService(new MockTranscriber(CANNED), storage, transcriptionRepo, objectsB, listenerB);
    const { taskId: taskC } = await insRoomAndTurnover(admin, C);
    const voiceC = await insVoiceDoc(admin, C);

    await transcriptionB.transcribe(C, voiceC);

    const afterClaim = await readObj(admin, taskC);
    check(afterClaim.claimed_state === 'ready', 'B: voice transcript drove claimed_state=ready');
    check(afterClaim.verified_state === 'conflict', 'B: deterministic engine returned CONFLICT (too-fast + missing snapshot)');
    check(near(afterClaim.verification_score, 0.5), `B: conflict verification score ≈ 0.50 (got ${afterClaim.verification_score})`);

    const ledger = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM verification_ledger WHERE object_id=$1`, [taskC]);
    check((ledger.rows[0]?.n ?? 0) >= 1, 'B: verification_ledger row written by the deterministic engine (not STT/LLM)');

    const snap = await admin.query<{ id: string }>(`INSERT INTO objects (tenant_id, type, properties) VALUES ($1,'Snapshot','{}'::jsonb) RETURNING id`, [C]);
    await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,'references')`, [C, snap.rows[0]!.id, taskC]);
    const reVerified = await verification.verifyObject(C, taskC);
    check(reVerified?.verifiedState === 'verified', 'B: snapshot attached → re-verify → VERIFIED');
    check(near(reVerified?.verificationScore ?? 0, 0.855), `B: verified verification score ≈ 0.855 (got ${reVerified?.verificationScore})`);

    // ── Part C: APPEND-ONLY IMMUTABILITY + TENANT ISOLATION ───────────────────────────────
    let blocked = false;
    try {
      await admin.query(`UPDATE transcription_log SET status='tampered' WHERE tenant_id=$1`, [C]);
    } catch {
      blocked = true;
    }
    check(blocked, 'C: append-only — UPDATE on transcription_log is rejected by forbid_mutation()');

    const other = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM transcription_log WHERE tenant_id=$1`, [B]);
    check((other.rows[0]?.n ?? 0) === 0, 'C: an untouched tenant has zero transcription_log rows (RLS isolation)');

    // ── Part D: SCOPED VOICE FEED (read-only; verdict join; RLS isolation) ─────────────────
    const feedA = await transcriptionRepo.listVoiceFeed(A);
    check(feedA.length === 1 && feedA[0]!.objectId === voiceA, 'D: feed(A) returns exactly tenant A\'s voice doc');
    check((feedA[0]!.properties.transcript as { status?: string } | undefined)?.status === 'done', 'D: feed carries the transcript on the doc properties');
    check(feedA[0]!.verdict === null, 'D: feed(A) verdict is null (no verifier ran in Part A)');

    const feedC = await transcriptionRepo.listVoiceFeed(C);
    check(feedC.length === 1 && feedC[0]!.objectId === voiceC, 'D: feed(C) returns tenant C\'s voice doc');
    check(feedC[0]!.verdict?.verifiedState === 'verified' && near(feedC[0]!.verdict?.verificationScore, 0.855), 'D: feed(C) verdict = verified@0.855 (joined from the driving Task)');

    const feedB = await transcriptionRepo.listVoiceFeed(B);
    check(feedB.length === 0, 'D: feed(B) is empty — RLS scopes the feed to the tenant');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} voice-transcription integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
