/**
 * S3 end-to-end: extends the Room-3 story through the event seam to a ranked cue.
 * A conflicted verification (S2) publishes verification.completed → the patient-flow agent
 * proposes → the orchestrator persists a Recommendation (addresses the Alert, references the
 * task) → it appears in GET /recommendations. Also: approve/dismiss, cross-tenant, tempo.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { RealtimeService } from '../src/objects/realtime.service';
import { DomainEventBus } from '../src/events/domain-event-bus';
import { DeterministicScorer } from '../src/verification/scorer';
import { VerificationRepository } from '../src/verification/verification.repository';
import { VerificationService } from '../src/verification/verification.service';
import { RecommendationRepository } from '../src/recommendations/recommendation.repository';
import { RecommendationService } from '../src/recommendations/recommendation.service';
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
  const bus = new DomainEventBus();
  const realtime = new RealtimeService();
  const verification = new VerificationService(new DeterministicScorer(), new VerificationRepository(), realtime, bus);
  const recommendations = new RecommendationService(new RecommendationRepository(), realtime, bus); // subscribes to verification.completed
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('S3 domain agents + orchestrator:');

    const task = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1, 'Task', $2::jsonb, 'ready') RETURNING id`,
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

    // Verify → conflict → (bus) verification.completed → recommendation pipeline runs synchronously.
    const result = await verification.verifyObject(A, taskId);
    check(result?.verifiedState === 'conflict', 'verification produced a conflict');

    const open = await recommendations.feed(A, 'open', 20);
    const cue = open.find((r) => r.objectId === taskId);
    check(!!cue, 'a ranked Recommendation was created from the conflict');
    check(cue?.domain === 'patient_flow', 'cue came from the patient-flow agent');
    check((cue?.evidence ?? []).some((e) => e.kind === 'verification'), 'cue carries the verification as evidence');
    check(cue?.rank === 1, 'cue is ranked');

    const recId = cue!.id;
    check((await count(admin, `SELECT count(*)::int AS n FROM links WHERE from_object=$1 AND relation='addresses'`, [recId])) === 1, 'Recommendation --addresses--> Alert');
    check((await count(admin, `SELECT count(*)::int AS n FROM links WHERE from_object=$1 AND to_object=$2 AND relation='references'`, [recId, taskId])) === 1, 'Recommendation --references--> task');
    check((await count(admin, `SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND event_type='recommendation.created'`, [recId])) === 1, 'recommendation.created event emitted');

    // Idempotent: re-verify does not duplicate the open cue.
    await verification.verifyObject(A, taskId);
    check((await recommendations.feed(A, 'open', 20)).filter((r) => r.objectId === taskId).length === 1, 're-verify does not duplicate the cue');

    // Human-in-the-loop: approve records intent (no world write) and moves it out of the open feed.
    const approved = await recommendations.act(A, recId, 'approved');
    check(approved.status === 'approved', 'approve updates status');
    check(!(await recommendations.feed(A, 'open', 20)).some((r) => r.id === recId), 'approved cue leaves the open feed');
    check((await recommendations.feed(A, 'approved', 20)).some((r) => r.id === recId), 'approved cue shows under approved');
    check((await count(admin, `SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND event_type='recommendation.approved'`, [recId])) === 1, 'recommendation.approved event emitted');

    // Cross-tenant isolation.
    check((await recommendations.feed(B, 'open', 20)).length === 0, 'tenant B sees no cues');
    check((await recommendations.runForObject(B, taskId)).length === 0, 'tenant B cannot run agents on tenant A object (RLS)');

    // Operating tempo reflects the open conflict.
    const tempo = await recommendations.tempo(A);
    check(tempo.openConflicts >= 1 && tempo.score < 100, 'operating tempo reflects the conflict');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} recommendation integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
