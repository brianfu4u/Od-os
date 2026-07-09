/**
 * P4 · S8 learning loop — the DoD, end to end against a real Postgres.
 * Proves: learning_feedback is append-only + tenant-isolated; a deterministic `learn` run produces
 * BOUNDED, audited parameter changes; a repeatedly-ignored domain is downgraded; an evidence kind
 * that repeatedly correlates with completion has its weight raised (never past max); S2 reads the
 * raised weight back (confidence rises); S3 reads the penalty back; runs are reversible; low sample
 * does not tune; cross-tenant isolation holds.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { DeterministicScorer } from '../src/verification/scorer';
import { VerificationRepository } from '../src/verification/verification.repository';
import { LearningRepository } from '../src/learning/learning.repository';
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
  const learning = new LearningRepository();
  const verification = new VerificationRepository();
  const scorer = new DeterministicScorer();
  const A = randomUUID();
  const B = randomUUID();

  const insObj = async (t: string, type: string, props: Record<string, unknown>, claimed?: string): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
        [t, type, JSON.stringify(props), claimed ?? null],
      )
    ).rows[0]!.id;
  const fb = async (t: string, kind: string, o: { domain?: string; taskType?: string; toState?: string; evidenceKinds?: string[] } = {}): Promise<void> => {
    await admin.query(
      `INSERT INTO learning_feedback (tenant_id, kind, domain, task_type, to_state, evidence_kinds) VALUES ($1,$2,$3,$4,$5,$6)`,
      [t, kind, o.domain ?? null, o.taskType ?? null, o.toState ?? null, o.evidenceKinds ?? null],
    );
  };
  const taskWeight = async (t: string, taskType: string, kind: string): Promise<number | undefined> => {
    const r = await admin.query<{ value: { weights?: Record<string, number> } }>(
      `SELECT value FROM learning_params WHERE tenant_id=$1 AND param_type='task' AND param_key=$2`,
      [t, taskType],
    );
    return r.rows[0]?.value?.weights?.[kind];
  };

  try {
    console.log('P4 · S8 learning loop:');

    // A Room-3 room_turnover with a snapshot but NO timing anomaly → verifies at the default weight.
    const taskId = await insObj(A, 'Task', { taskType: 'room_turnover', requiredEvidence: ['snapshot'], label: 'Room 3' }, 'ready');
    const snapId = await insObj(A, 'Snapshot', { kind: 'photo' });
    await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,'references')`, [A, snapId, taskId]);
    const r0 = await verification.verify(A, taskId, scorer);
    const conf0 = r0!.result.confidence;
    check(r0!.result.verifiedState === 'verified', 'baseline: verified at default snapshot weight');

    // ── Seed feedback: marketing repeatedly ignored (≥ minSample); financial only 3 (low sample);
    //    room_turnover verdict corrections toward verified with snapshot present. ──
    for (let i = 0; i < 5; i += 1) await fb(A, 'recommendation_dismissed', { domain: 'marketing' });
    for (let i = 0; i < 3; i += 1) await fb(A, 'recommendation_dismissed', { domain: 'financial' });
    for (let i = 0; i < 5; i += 1) await fb(A, 'verdict_correction', { taskType: 'room_turnover', toState: 'verified', evidenceKinds: ['snapshot'] });
    // tenant B gets its own (isolated) feedback.
    for (let i = 0; i < 5; i += 1) await fb(B, 'recommendation_dismissed', { domain: 'equipment' });

    // ── learn (run 1) ──
    const run1 = await learning.run(A);
    check(run1.feedbackConsidered === 13, `learn considered tenant A feedback only (${run1.feedbackConsidered} = 13)`);
    const mk = run1.changes.find((c) => c.paramType === 'domain_priority' && c.paramKey === 'marketing');
    check(!!mk && mk.after === 0.5 && mk.before === 0, 'ignored domain (marketing) downgraded 0 → 0.5 (bounded step)');
    const sw = run1.changes.find((c) => c.paramKey === 'room_turnover' && c.field === 'weights.snapshot');
    check(!!sw && Math.abs(sw.after - 1.1) < 1e-9 && sw.after <= 2.0, 'snapshot weight raised 1.0 → 1.1 (in bounds)');
    check(run1.changes.every((c) => typeof c.basis.sampleSize === 'number'), 'every change carries an auditable basis');

    // low sample: financial (3 < minSample) must NOT be tuned.
    check(!run1.changes.some((c) => c.paramKey === 'financial'), 'low-sample domain (financial) NOT adjusted');

    // ── S2 closes the loop: re-verify → confidence rises because the snapshot weight went up. ──
    const r1 = await verification.verify(A, taskId, scorer);
    check(r1!.result.confidence > conf0, `S2 read back the raised weight (confidence ${conf0} → ${r1!.result.confidence})`);

    // ── S3 closes the loop: the learned domain penalty is readable for the orchestrator. ──
    const penalties = await learning.getDomainPriorityPenalties(A);
    check(penalties.marketing === 0.5, 'S3 read back marketing priority penalty = 0.5');
    check(penalties.financial === undefined, 'no penalty learned for the low-sample domain');

    // ── learning_feedback + audit are APPEND-ONLY ──
    await expectThrow(() => admin.query(`UPDATE learning_feedback SET kind='x' WHERE tenant_id=$1`, [A]), 'learning_feedback UPDATE blocked (append-only)');
    await expectThrow(() => admin.query(`DELETE FROM learning_feedback WHERE tenant_id=$1`, [A]), 'learning_feedback DELETE blocked (append-only)');
    await expectThrow(() => admin.query(`UPDATE learning_audit SET field='x' WHERE tenant_id=$1`, [A]), 'learning_audit UPDATE blocked (append-only)');

    // ── Tenant isolation ──
    check((await learning.listFeedback(B)).every((f) => true) && (await learning.listFeedback(B)).length === 5, 'tenant B sees only its own feedback');
    const runB = await learning.run(B);
    check(!runB.changes.some((c) => c.paramKey === 'marketing'), "tenant B's learn never touches tenant A domains");
    check((await learning.getDomainPriorityPenalties(A)).equipment === undefined, "tenant B's learned penalty did not leak into A");

    // ── Repeatable + reversible ──
    const run2 = await learning.run(A);
    check(Math.abs((await taskWeight(A, 'room_turnover', 'snapshot'))! - 1.2) < 1e-9, 'repeat run converges another bounded step (1.1 → 1.2)');
    void run2;
    const rb = await learning.rollback(A);
    check(rb.reverted > 0, `rollback reverted the last run (${rb.reverted} fields)`);
    check(Math.abs((await taskWeight(A, 'room_turnover', 'snapshot'))! - 1.1) < 1e-9, 'rollback restored snapshot weight 1.2 → 1.1');
    check((await learning.getDomainPriorityPenalties(A)).marketing === 0.5, 'rollback restored marketing penalty to 0.5');

    // audit trail is readable.
    check((await learning.listAudit(A)).some((a) => a.kind === 'rollback'), 'audit trail records the rollback');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} learning integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
