/**
 * feat/manager-task-assign integration (against $DATABASE_URL). Proves the manager write path:
 *  - assign writes an assignedTo link that T5's /tasks/mine (TasksRepository.listMine) immediately reflects;
 *  - reassign is an idempotent REPLACE — the task leaves the old staff's list and joins the new one;
 *  - cross-tenant is impossible: a manager of A cannot assign A's task to B's staff, nor B's task to
 *    A's staff (both resolve to null → 404), and B's overview never shows A's tasks;
 *  - verified_state is NEVER written by assign or create (moat intact);
 *  - create makes a Task in-tenant (+ optional assign), with verified_state null.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { withTenant } from '../src/database/tenant-context';
import { closePool } from '../src/database/pool';
import { AssignmentRepository } from '../src/assignments/assignment.repository';
import { TasksRepository } from '../src/tasks/tasks.repository';
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

async function insertObject(c: PoolClient, tenantId: string, type: string, properties: Record<string, unknown>): Promise<string> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [tenantId, type, JSON.stringify(properties)],
  );
  return res.rows[0]!.id;
}
const staffIdentity = (tenantId: string, staffId: string): SessionIdentity => ({ subject: 'staff', tenantId, staffId });

async function verifiedStateOf(tenantId: string, id: string): Promise<string | null | undefined> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ verified_state: string | null }>(`SELECT verified_state FROM objects WHERE id = $1`, [id]);
    return r.rows[0]?.verified_state;
  });
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new AssignmentRepository();
  const tasks = new TasksRepository();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('feat/manager-task-assign:');

    // Seed: tenant A with two staff + a task; tenant B with one staff + a task.
    const { s1, s2, t1 } = await withTenant(A, async (c) => ({
      s1: await insertObject(c, A, 'Staff', { staffHandle: 'nurse-a', displayName: 'Nurse A', role: 'staff' }),
      s2: await insertObject(c, A, 'Staff', { staffHandle: 'nurse-b', displayName: 'Nurse B', role: 'staff' }),
      t1: await insertObject(c, A, 'Task', { taskType: 'prep', label: 'Prep room 3' }),
    }));
    const { sb, tb } = await withTenant(B, async (c) => ({
      sb: await insertObject(c, B, 'Staff', { staffHandle: 'nurse-x', displayName: 'Nurse X', role: 'staff' }),
      tb: await insertObject(c, B, 'Task', { taskType: 'prep', label: 'B task' }),
    }));

    // 1) Assign t1 → s1; T5 listMine reflects it.
    const a1 = await repo.assign(A, t1, s1, 'manager:test');
    check(a1?.assignee?.staffId === s1, 'assign returns the new assignee');
    const mineS1 = await tasks.listMine(A, staffIdentity(A, s1));
    check(mineS1.some((t) => t.taskId === t1), 'staff s1 now sees t1 in /tasks/mine');

    // 2) Reassign t1 → s2; leaves s1, joins s2 (idempotent replace).
    await repo.assign(A, t1, s2, 'manager:test');
    const mineS1b = await tasks.listMine(A, staffIdentity(A, s1));
    const mineS2 = await tasks.listMine(A, staffIdentity(A, s2));
    check(!mineS1b.some((t) => t.taskId === t1), 'after reassign, s1 no longer sees t1');
    check(mineS2.some((t) => t.taskId === t1), 'after reassign, s2 sees t1');

    // 3) Cross-tenant: cannot assign A's task to B's staff, nor B's task to A's staff.
    check((await repo.assign(A, t1, sb, 'manager:test')) === null, "cannot assign A's task to B's staff (→404)");
    check((await repo.assign(A, tb, s1, 'manager:test')) === null, "cannot assign B's task to A's staff (→404)");

    // 4) Overview is tenant-scoped: A sees t1, B does not.
    const ovA = await repo.overview(A);
    const ovB = await repo.overview(B);
    check(ovA.tasks.some((t) => t.taskId === t1), 'overview(A) includes t1');
    check(!ovB.tasks.some((t) => t.taskId === t1), 'overview(B) excludes A task t1 (RLS)');
    check(ovA.staff.some((s) => s.staffId === s1) && !ovB.staff.some((s) => s.staffId === s1), 'overview staff is tenant-scoped');

    // 5) Moat: assign never wrote verified_state.
    check((await verifiedStateOf(A, t1)) === null, 'assign never wrote verified_state (still null)');

    // 6) Create a task (+ assign) in tenant A; verified_state null; visible to assignee.
    const created = await repo.createTask(A, { label: 'Restock trays', taskType: 'restock', dueBy: null, staffId: s1 }, 'manager:test');
    check(!!created && created.assignee?.staffId === s1, 'createTask returns the new task assigned to s1');
    check((await verifiedStateOf(A, created!.taskId)) === null, 'created task has verified_state null (moat)');
    const mineS1c = await tasks.listMine(A, staffIdentity(A, s1));
    check(mineS1c.some((t) => t.taskId === created!.taskId), 'assignee sees the newly created task');

    // 7) Create with a cross-tenant assignee → null (creates nothing).
    check((await repo.createTask(A, { label: 'x', staffId: sb }, 'manager:test')) === null, 'createTask with B staff → null');
  } finally {
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} manager-task-assign integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
