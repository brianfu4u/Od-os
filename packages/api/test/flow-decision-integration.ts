/**
 * feat/flow-id-manager-decision integration (against $DATABASE_URL). Proves the IRON LAW of the flow
 * lifecycle end-to-end at the repository layer (the same path the manager controller drives):
 *
 *   One task = one flow. flow_id is minted at creation (= the task's own id) and never changes.
 *   The flow starts `pending` and ONLY moves to `closed` when a manager explicitly APPROVES.
 *   REJECT — any number of times — does NOT close the flow; it stays `pending` within the SAME flow
 *   and records a structured, employee-visible reason. SHELVE leaves the flow `pending` and silent.
 *   APPROVE is terminal: a closed flow can never be reopened, re-approved, or rejected (→ 409).
 *
 * Also asserts the guardrails: decide() NEVER writes verified_state (S2 verdict stays reference data),
 * the rejection reason is persisted + surfaced identically to manager overview and employee MyTasks,
 * cross-tenant decide is impossible (→ null / 404), and reject requires a valid structured category.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { withTenant } from '../src/database/tenant-context';
import { closePool } from '../src/database/pool';
import {
  AssignmentRepository,
  FlowAlreadyClosedError,
  InvalidRejectionReasonError,
} from '../src/assignments/assignment.repository';
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
async function expectThrow(fn: () => Promise<unknown>, ctor: new (...a: never[]) => Error, label: string): Promise<void> {
  try {
    await fn();
    check(false, `${label} (expected throw, got none)`);
  } catch (e) {
    check(e instanceof ctor, `${label} (${e instanceof Error ? e.constructor.name : typeof e})`);
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

async function flowRow(tenantId: string, id: string): Promise<{ flow_id: string | null; flow_state: string | null; verified_state: string | null }> {
  return withTenant(tenantId, async (c) => {
    const r = await c.query<{ flow_id: string | null; flow_state: string | null; verified_state: string | null }>(
      `SELECT flow_id, flow_state, verified_state FROM objects WHERE id = $1`,
      [id],
    );
    return r.rows[0] ?? { flow_id: null, flow_state: null, verified_state: null };
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
    console.log('feat/flow-id-manager-decision:');

    // Seed: tenant A (one staff), tenant B (one staff + a task, for the cross-tenant probe).
    const { s1 } = await withTenant(A, async (c) => ({
      s1: await insertObject(c, A, 'Staff', { staffHandle: 'nurse-a', displayName: 'Nurse A', role: 'staff' }),
    }));
    const { tb } = await withTenant(B, async (c) => ({
      tb: await insertObject(c, B, 'Task', { taskType: 'prep', label: 'B task' }),
    }));

    // ---- A. flow_id minted at creation; starts pending ----
    const created = await repo.createTask(A, { label: 'Prep room 3', taskType: 'prep', staffId: s1 }, 'manager:test');
    check(!!created, 'createTask succeeds');
    const taskId = created!.taskId;
    const f0 = await flowRow(A, taskId);
    check(f0.flow_id === taskId, 'flow_id is minted at creation, equal to the task id (task IS a flow)');
    check(f0.flow_state === 'pending', 'a new flow starts in pending state');
    check(f0.verified_state === null, 'created task has verified_state null (S2 moat)');

    // Test fixture: use the same transaction-local authorization as S2 to stamp reference data,
    // then prove decide() never touches it later. This is setup, not a production verdict path.
    await withTenant(A, async (c) => {
      await c.query(`SET LOCAL app.verification_write = 'true'`);
      await c.query(`UPDATE objects SET verified_state = 'below_target', verification_score = 0.42 WHERE id = $1`, [taskId]);
    });

    // ---- REJECT does NOT close the flow; stays pending in the SAME flow; reason persisted ----
    const d1 = await repo.decide(A, taskId, {
      decision: 'reject',
      rejectionReasonCategory: 'missing_evidence',
      rejectionReasonDetail: 'No photo of the cleared tray attached.',
    }, 'manager:test');
    check(d1?.result.decision === 'reject' && d1?.result.flowState === 'pending', 'REJECT keeps flowState pending (flow NOT closed)');
    check(d1?.result.flowId === taskId, 'REJECT result carries the same flow_id');
    check(d1?.notifyEmployee === true, 'REJECT notifies the employee');
    check(d1?.employeeId === s1, 'REJECT resolves the assigned employee as the notify target');
    check((await flowRow(A, taskId)).flow_state === 'pending', 'DB flow_state still pending after REJECT');

    // Reason surfaces identically to the manager overview AND the employee MyTasks (same projection).
    const ov1 = await repo.overview(A);
    const ovTask1 = ov1.tasks.find((t) => t.taskId === taskId);
    check(ovTask1?.flowState === 'pending', 'overview shows the flow as pending');
    check(ovTask1?.rejection?.category === 'missing_evidence', 'overview surfaces the structured rejection category');
    check(ovTask1?.rejection?.detail === 'No photo of the cleared tray attached.', 'overview surfaces the rejection detail');
    check(ovTask1?.rejection?.count === 1, 'overview rejection count is 1 after first reject');

    const mine1 = await tasks.listMine(A, staffIdentity(A, s1));
    const mineTask1 = mine1.find((t) => t.taskId === taskId);
    check(mineTask1?.flowState === 'pending', 'employee MyTasks shows the flow pending');
    check(mineTask1?.rejection?.category === 'missing_evidence', 'employee sees the SAME rejection category as the manager');
    check(mineTask1?.rejection?.detail === 'No photo of the cleared tray attached.', 'employee sees the SAME rejection detail');

    // ---- Multiple rejections still do NOT close; count increments within the SAME flow ----
    const d2 = await repo.decide(A, taskId, {
      decision: 'reject',
      rejectionReasonCategory: 'needs_more_detail',
      rejectionReasonDetail: null,
    }, 'manager:test');
    check(d2?.result.flowState === 'pending', 'second REJECT still keeps the flow pending');
    const ov2 = await repo.overview(A);
    const ovTask2 = ov2.tasks.find((t) => t.taskId === taskId);
    check(ovTask2?.rejection?.category === 'needs_more_detail', 'latest rejection reason replaces the prior one');
    check(ovTask2?.rejection?.count === 2, 'rejection count is 2 after the second reject (same flow)');
    check((await flowRow(A, taskId)).flow_id === taskId, 'flow_id is unchanged across rejections');

    // ---- SHELVE: stays pending, silent (no employee notification) ----
    const d3 = await repo.decide(A, taskId, { decision: 'shelve' }, 'manager:test');
    check(d3?.result.decision === 'shelve' && d3?.result.flowState === 'pending', 'SHELVE keeps the flow pending');
    check(d3?.notifyEmployee === false, 'SHELVE is silent — no employee notification');
    check((await flowRow(A, taskId)).flow_state === 'pending', 'DB flow_state still pending after SHELVE');

    // ---- REJECT requires a valid structured category ----
    await expectThrow(
      () => repo.decide(A, taskId, { decision: 'reject', rejectionReasonCategory: null }, 'manager:test'),
      InvalidRejectionReasonError,
      'REJECT without a valid category is refused',
    );

    // ---- APPROVE closes the flow (terminal) ----
    const d4 = await repo.decide(A, taskId, { decision: 'approve' }, 'manager:test');
    check(d4?.result.decision === 'approve' && d4?.result.flowState === 'closed', 'APPROVE moves the flow to closed');
    check(d4?.notifyEmployee === true, 'APPROVE notifies the employee');
    check((await flowRow(A, taskId)).flow_state === 'closed', 'DB flow_state is closed after APPROVE');

    // Employee-side: a closed flow drops the rejection banner (rejection only shown while pending).
    const mineClosed = await tasks.listMine(A, staffIdentity(A, s1));
    const mineTaskClosed = mineClosed.find((t) => t.taskId === taskId);
    check(mineTaskClosed?.flowState === 'closed', 'employee MyTasks shows the flow closed after approve');
    check(mineTaskClosed?.rejection == null, 'closed flow no longer surfaces a rejection banner to the employee');

    // ---- Terminal: a closed flow can NEVER be reopened / re-approved / rejected ----
    await expectThrow(() => repo.decide(A, taskId, { decision: 'approve' }, 'manager:test'), FlowAlreadyClosedError, 'APPROVE on a closed flow → conflict (no re-close)');
    await expectThrow(
      () => repo.decide(A, taskId, { decision: 'reject', rejectionReasonCategory: 'other' }, 'manager:test'),
      FlowAlreadyClosedError,
      'REJECT on a closed flow → conflict (no reopen)',
    );
    await expectThrow(() => repo.decide(A, taskId, { decision: 'shelve' }, 'manager:test'), FlowAlreadyClosedError, 'SHELVE on a closed flow → conflict');

    // ---- Guardrail: decide() NEVER touched verified_state (S2 verdict is reference data only) ----
    const fFinal = await flowRow(A, taskId);
    check(fFinal.verified_state === 'below_target', 'verified_state is unchanged through the whole flow (S2 moat intact)');

    // ---- Cross-tenant: manager of A cannot decide on B's task (→ null / 404) ----
    check((await repo.decide(A, tb, { decision: 'approve' }, 'manager:test')) === null, "cannot decide on another tenant's task (→404)");
    check((await flowRow(B, tb)).flow_state !== 'closed', "B's task was not affected by A's decide attempt");
  } finally {
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} flow-id-manager-decision integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
