/**
 * T-11-B · 跨端闭环 E2E (embedded Postgres, real RLS).
 *
 * WHY THIS FILE EXISTS (收口 gap-fill):
 *   The individual layers (claim, scan, attention, decide) each have their own integration script,
 *   but no single test walks the WHOLE loop the way the two front-ends actually drive it. This file
 *   asserts the closed loop end to end at the repository/service boundary, in one narrative:
 *
 *     员工端                      后端投影                     经理端(只读)                 裁决
 *     ─────                      ────────                    ────────────                ────
 *     claim(status) ─┐
 *     scan(code)   ──┼─▶ Staff.claimed_state / events ─▶ statusBoard + attention queue ─▶ decide(task)
 *                    │        (world state)                (read-only, no mutation)      (reject→employee,
 *                    │                                                                    AI verdict never)
 *
 *   The invariants proven by walking the loop (numbered as in the project spec):
 *     1. 员工提交不驳回 — the employee's claim + scan both succeed and record.
 *     2/3. AI 判断不回流 / 三层分离 — the manager side can carry a verification verdict, but the
 *          employee-facing projection (currentForCaller, MyTasks) never carries it.
 *     4. attention 只读 — building board + queue mutates NO world state and emits NO employee event.
 *     裁决单一归属 — decide() reject reason flows to the SAME employee (MyTasks), decide() NEVER
 *          touches verified_state (S2 moat), and the AI verdict never rides along with the reason.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { withTenant } from '../src/database/tenant-context';
import { closePool } from '../src/database/pool';
import { EmployeeStatusRepository } from '../src/employee-status/employee-status.repository';
import { ScansRepository } from '../src/scans/scans.repository';
import { AttentionRepository } from '../src/attention/attention.repository';
import { dedupForDisplay } from '../src/attention/rules/attention-dedup';
import { AssignmentRepository } from '../src/assignments/assignment.repository';
import { TasksRepository } from '../src/tasks/tasks.repository';
import type { SessionIdentity } from '../src/auth/session.types';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

async function insertObject(c: PoolClient, tenantId: string, type: string, properties: Record<string, unknown>, claimedState?: string): Promise<string> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
    [tenantId, type, JSON.stringify(properties), claimedState ?? null],
  );
  return res.rows[0]!.id;
}
const ident = (tenantId: string, staffId: string): SessionIdentity => ({ subject: 'staff', tenantId, staffId });

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const empRepo = new EmployeeStatusRepository();
  const scanRepo = new ScansRepository();
  const attnRepo = new AttentionRepository();
  const assignRepo = new AssignmentRepository();
  const tasks = new TasksRepository();
  const A = randomUUID();

  try {
    console.log('T-11-B 跨端闭环 E2E — employee → projection → manager(read-only) → decide:\n');

    // Seed one staff (the loop's employee/assignee).
    const staff = await withTenant(A, async (c) =>
      insertObject(c, A, 'Staff', { staffHandle: 'nurse-a', displayName: 'Nurse A', role: 'staff' }, undefined));

    // ── STEP 1 · 员工端提交 (claim + scan) — both succeed (原则 1) ──
    console.log('STEP 1 · 员工端提交:');
    const claim = await empRepo.submitClaim(A, ident(A, staff), 'busy', '正在配镜', null);
    check(claim.view.claimedStatus === 'busy', '1·员工 claim 提交成功 (never rejected)');
    const scan = await scanRepo.submitScan(A, ident(A, staff), { patientCode: 'unknown-999' });
    check(!!scan.scanId && scan.visitLinkStatus === 'unresolved', '1·员工 scan 提交成功并记录 (even when unresolved)');

    // ── STEP 2 · 后端投影 — the claim projects onto world state (Staff.claimed_state) ──
    console.log('STEP 2 · 后端投影:');
    const projected = await withTenant(A, async (c) =>
      (await c.query<{ claimed_state: string }>(`SELECT claimed_state FROM objects WHERE id = $1`, [staff])).rows[0]!.claimed_state);
    check(projected === 'busy', '2·claim 投影到世界状态 Staff.claimed_state');

    // ── STEP 3 · 经理端只读 (board + attention) — visible, and building it mutates nothing ──
    console.log('STEP 3 · 经理端只读:');
    const worldBefore = await withTenant(A, async (c) =>
      JSON.stringify((await c.query(`SELECT id, claimed_state FROM objects WHERE tenant_id = $1 ORDER BY id`, [A])).rows));
    const empEventsBefore = await withTenant(A, async (c) =>
      Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM events WHERE tenant_id = $1 AND actor = 'employee'`, [A])).rows[0]!.n));

    const board = await empRepo.statusBoard(A);
    const boardRow = board.find((r) => r.employeeId === staff);
    check(boardRow?.claimedStatus === 'busy', '3·经理 board 只读可见员工 claimedStatus');
    check(!('verificationResult' in (boardRow ?? {})) && !('verificationConfidence' in (boardRow ?? {})),
      '3·board 行不含任何 verification 字段 (AI 判断不泄露到经理只读视图的员工镜像)');

    const gen = await attnRepo.generateAndAudit(A);
    const items = dedupForDisplay(gen.candidates);
    check(Array.isArray(items), '3·经理 attention 队列可读 (broadcast/read-only)');

    const worldAfter = await withTenant(A, async (c) =>
      JSON.stringify((await c.query(`SELECT id, claimed_state FROM objects WHERE tenant_id = $1 ORDER BY id`, [A])).rows));
    const empEventsAfter = await withTenant(A, async (c) =>
      Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM events WHERE tenant_id = $1 AND actor = 'employee'`, [A])).rows[0]!.n));
    check(worldBefore === worldAfter, '4·读取 board + attention 不改动任何世界状态');
    check(empEventsBefore === empEventsAfter, '4·读取 board + attention 不产生任何员工可见事件');

    // ── STEP 4 · 裁决闭环 — manager decides; reject reason flows to the SAME employee, AI verdict never ──
    console.log('STEP 4 · 裁决闭环:');
    const created = await assignRepo.createTask(A, { label: 'Prep room 3', taskType: 'prep', staffId: staff }, 'manager:test');
    const taskId = created!.taskId;
    // Stamp a verified_state (S2 reference data) to prove decide() never touches it.
    await withTenant(A, async (c) => {
      await c.query(`UPDATE objects SET verified_state = 'below_target', confidence = 0.42 WHERE id = $1`, [taskId]);
    });

    const decision = await assignRepo.decide(A, taskId, {
      decision: 'reject',
      rejectionReasonCategory: 'missing_evidence',
      rejectionReasonDetail: '未附清台照片。',
    }, 'manager:test');
    check(decision?.result.decision === 'reject', '裁决:reject 成功');
    check(decision?.employeeId === staff, '裁决单一归属:reject 解析到被指派的同一员工');
    check(decision?.notifyEmployee === true, '裁决:员工被通知(reject reason 回流给员工)');

    // verified_state (S2 moat) is untouched by decide().
    const afterDecide = await withTenant(A, async (c) =>
      (await c.query<{ verified_state: string | null }>(`SELECT verified_state FROM objects WHERE id = $1`, [taskId])).rows[0]!);
    check(afterDecide.verified_state === 'below_target', 'S2 护城河:decide() 永不改写 verified_state');

    // The employee's MyTasks carries the SAME rejection reason — but NO AI verdict field.
    const mine = await tasks.listMine(A, ident(A, staff));
    const mineTask = mine.find((t) => t.taskId === taskId);
    check(mineTask?.rejection?.category === 'missing_evidence', '员工 MyTasks 看到与经理一致的 reject 分类(裁决理由回流)');
    check(mineTask?.rejection?.detail === '未附清台照片。', '员工 MyTasks 看到一致的 reject 详情');
    const mineKeys = JSON.stringify(mineTask ?? {});
    check(!mineKeys.includes('verificationResult') && !mineKeys.includes('verificationConfidence') && !mineKeys.includes('verified_state'),
      '员工 MyTasks 不含任何 AI 判断/verified_state 字段 (AI 判断永不回流员工)');
  } finally {
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} e2e employee-manager loop: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
