/**
 * P2 · S4 action write-back — the DoD, end to end against a real Postgres.
 * Proves: approving a LOW-RISK whitelisted cue performs the internal ontology write-back + writes an
 * append-only action_log row + emits an event (all in withTenant()); approving a HIGH-RISK cue is
 * NOT executed, only recorded; repeat approval is idempotent (no second write); reversible actions
 * undo and restore prior state; the action_log is append-only; and everything is tenant-isolated.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { RealtimeService } from '../src/objects/realtime.service';
import { DomainEventBus } from '../src/events/domain-event-bus';
import { RecommendationRepository } from '../src/recommendations/recommendation.repository';
import { RecommendationService } from '../src/recommendations/recommendation.service';
import { closePool } from '../src/database/pool';
import type { ProposedAction } from '@clearview/shared';

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
async function scalar(admin: Client, sql: string, p: unknown[]): Promise<string | null> {
  const r = await admin.query<{ v: string | null }>(sql, p);
  return r.rows[0]?.v ?? null;
}
async function count(admin: Client, sql: string, p: unknown[]): Promise<number> {
  return Number((await admin.query<{ n: string }>(sql, p)).rows[0]!.n);
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const realtime = new RealtimeService();
  const bus = new DomainEventBus();
  const service = new RecommendationService(new RecommendationRepository(), realtime, bus);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  const insObj = async (t: string, type: string, properties: Record<string, unknown>): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [t, type, JSON.stringify(properties)],
      )
    ).rows[0]!.id;
  const insRec = async (t: string, objectId: string, actions: ProposedAction[], domain = 'inventory'): Promise<string> =>
    insObj(t, 'Recommendation', {
      status: 'open', title: 'cue', why: 'why', domain, sourceAgent: domain,
      evidence: [], confidence: 0.8, rank: 1, objectId, actions,
    });
  const low = (actionType: string): ProposedAction => ({ label: actionType, actionType, riskTier: 'low', needsApproval: true });
  const high = (actionType: string): ProposedAction => ({ label: actionType, actionType, riskTier: 'high', needsApproval: true });

  try {
    console.log('P2 · S4 action write-back:');

    // ── 1) LOW-RISK EXECUTE: approve inventory_reorder → a restock Task is created ──
    const itemId = await insObj(A, 'InventoryItem', { name: 'Contact lens solution', sku: 'CLS-500', onHand: 2, reorderPoint: 5 });
    const recReorder = await insRec(A, itemId, [low('inventory_reorder')]);
    const afterApprove = await service.approve(A, recReorder, 'mgr-1');
    check(afterApprove.status === 'approved', 'approve sets status=approved');
    check(afterApprove.execution?.state === 'executed', 'execution marker = executed');
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM objects WHERE tenant_id=$1 AND type='Task' AND properties->>'taskType'='inventory_reorder' AND properties->>'forItem'=$2`, [A, itemId])) === 1,
      'a restock Task was actually created (internal write-back)',
    );
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1 AND recommendation_id=$2 AND result='executed' AND action_type='inventory_reorder'`, [A, recReorder])) === 1,
      'an action_log row (executed) was written',
    );
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM events WHERE tenant_id=$1 AND object_id=$2 AND event_type='action.executed'`, [A, recReorder])) === 1,
      'action.executed event emitted',
    );

    // ── 2) IDEMPOTENT: approving again does NOT execute a second time ──
    await service.approve(A, recReorder, 'mgr-1');
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM objects WHERE tenant_id=$1 AND type='Task' AND properties->>'taskType'='inventory_reorder' AND properties->>'forItem'=$2`, [A, itemId])) === 1,
      'repeat approve creates NO second Task (idempotent)',
    );
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1 AND recommendation_id=$2 AND result='executed'`, [A, recReorder])) === 1,
      'still exactly one executed action_log row (idempotent)',
    );

    // ── 3) HIGH-RISK BLOCK: approve a claim cue whose only real action is submit_claim (high) ──
    const claimId = await insObj(A, 'Claim', { label: 'CLM-2041', missingFields: ['referral'] });
    const recClaim = await insRec(A, claimId, [low('request_info'), high('submit_claim')], 'financial');
    const objBefore = await count(admin, `SELECT count(*)::text AS n FROM objects WHERE tenant_id=$1`, [A]);
    const claimRec = await service.approve(A, recClaim, 'mgr-1');
    check(claimRec.execution?.state === 'blocked_high_risk', 'high-risk cue → execution marker = blocked_high_risk');
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1 AND recommendation_id=$2 AND result='blocked_high_risk'`, [A, recClaim])) === 1,
      'high-risk approval recorded (blocked_high_risk) in action_log',
    );
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1 AND recommendation_id=$2 AND result='executed'`, [A, recClaim])) === 0,
      'NO executed row for the high-risk cue',
    );
    check((await count(admin, `SELECT count(*)::text AS n FROM objects WHERE tenant_id=$1`, [A])) === objBefore, 'high-risk approval created no objects (not executed)');

    // ── 4) UNDO (equipment_offline): status→offline + calibration Task; undo restores + archives ──
    const eqId = await insObj(A, 'Equipment', { label: 'OCT #9', status: 'ready' });
    const recEq = await insRec(A, eqId, [low('equipment_offline')], 'equipment');
    await service.approve(A, recEq, 'mgr-1');
    check((await scalar(admin, `SELECT properties->>'status' AS v FROM objects WHERE id=$1`, [eqId])) === 'offline', 'equipment set offline by write-back');
    const calId = await scalar(admin, `SELECT id::text AS v FROM objects WHERE tenant_id=$1 AND type='Task' AND properties->>'taskType'='equipment_calibration' AND properties->>'forEquipment'=$2`, [A, eqId]);
    check(!!calId, 'a calibration Task was created');
    const undone = await service.undo(A, recEq, 'mgr-1');
    check(undone.execution?.state === 'undone' && undone.status === 'open', 'undo reopens the cue and marks it undone');
    check((await scalar(admin, `SELECT properties->>'status' AS v FROM objects WHERE id=$1`, [eqId])) === 'ready', 'undo restored equipment status to ready');
    check((await scalar(admin, `SELECT properties->>'archived' AS v FROM objects WHERE id=$1`, [calId])) === 'true', 'undo archived the calibration Task');
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1 AND recommendation_id=$2 AND result='undone'`, [A, recEq])) === 1,
      'undo wrote an append-only undone action_log row',
    );
    // undo is idempotent
    await service.undo(A, recEq, 'mgr-1');
    check((await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1 AND recommendation_id=$2 AND result='undone'`, [A, recEq])) === 1, 'repeat undo is idempotent (still one undone row)');

    // ── 5) UNDO (reassign_task): assignedTo set, then restored ──
    const taskId = await insObj(A, 'Task', { taskType: 'pretest_done', label: 'Bay 2 pretest', reassignTo: 'A · Tech' });
    const recReassign = await insRec(A, taskId, [low('reassign_task')], 'staff');
    await service.approve(A, recReassign, 'mgr-1');
    check((await scalar(admin, `SELECT properties->>'assignedTo' AS v FROM objects WHERE id=$1`, [taskId])) === 'A · Tech', 'reassign set assignedTo');
    await service.undo(A, recReassign, 'mgr-1');
    check((await scalar(admin, `SELECT properties->>'assignedTo' AS v FROM objects WHERE id=$1`, [taskId])) === null, 'undo removed assignedTo (restored prior state)');

    // ── 5c) CONCURRENCY (P2.1): two parallel approves of one cue → exactly one execution ──
    const raceItem = await insObj(A, 'InventoryItem', { name: 'Saline', sku: 'SAL-1', onHand: 0, reorderPoint: 4 });
    const raceRec = await insRec(A, raceItem, [low('inventory_reorder')]);
    await Promise.all([
      service.approve(A, raceRec, 'mgr-1').catch(() => undefined),
      service.approve(A, raceRec, 'mgr-1').catch(() => undefined),
    ]);
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1 AND recommendation_id=$2 AND result='executed'`, [A, raceRec])) === 1,
      'concurrent approves → exactly one executed action_log row (claim-first idempotency)',
    );
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM objects WHERE tenant_id=$1 AND type='Task' AND properties->>'forItem'=$2 AND (properties->>'archived') IS DISTINCT FROM 'true'`, [A, raceItem])) === 1,
      'concurrent approves → exactly one Task created (no double side effect)',
    );

    // ── 6) ACTION_LOG is APPEND-ONLY ──
    await expectThrow(
      () => admin.query(`UPDATE action_log SET actor='tamper' WHERE recommendation_id=$1`, [recReorder]),
      'action_log UPDATE is blocked (append-only trigger)',
    );
    await expectThrow(
      () => admin.query(`DELETE FROM action_log WHERE recommendation_id=$1`, [recReorder]),
      'action_log DELETE is blocked (append-only trigger)',
    );

    // ── 7) CROSS-TENANT isolation ──
    check((await service.actionLog(B, recReorder)).length === 0, 'tenant B cannot read tenant A action_log (RLS)');
    await expectThrow(() => service.approve(B, recReorder, 'mgr-B'), 'tenant B cannot approve tenant A recommendation (RLS → not found)');
    check(
      (await count(admin, `SELECT count(*)::text AS n FROM action_log WHERE tenant_id=$1`, [B])) === 0,
      'no action_log rows leaked into tenant B',
    );
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} action write-back integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
