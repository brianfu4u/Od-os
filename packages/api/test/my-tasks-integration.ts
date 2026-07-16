/**
 * T5 · "My tasks" projection (embedded Postgres). Proves the read-only list is scoped by BOTH the
 * tenant (RLS) and the caller's own assignedTo links: a staff sees only their own tenant's tasks
 * assigned to them — never another staff's, never another tenant's. Verdict passes through from
 * Task.verified_state (S2); no writes.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { TasksRepository } from '../src/tasks/tasks.repository';
import { closePool } from '../src/database/pool';
import type { SessionIdentity } from '../src/auth/session.types';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

async function insObject(admin: Client, tenant: string, type: string, properties: Record<string, unknown>, verified: string | null = null, verificationScore: number | null = null): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, verified_state, verification_score) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING id`,
    [tenant, type, JSON.stringify(properties), verified, verificationScore],
  );
  return res.rows[0]!.id;
}
async function link(admin: Client, tenant: string, from: string, to: string, relation: string): Promise<void> {
  await admin.query(`INSERT INTO links (tenant_id, from_object, to_object, relation) VALUES ($1,$2,$3,$4)`, [tenant, from, to, relation]);
}
const ident = (tenantId: string, staffId: string): SessionIdentity => ({ subject: 'staff', tenantId, staffId });

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new TasksRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('T5 my-tasks — tenant + assignee isolation:');

    // Tenant A: staff SA + SA2; task1 → SA (with a Room), task2 → SA2.
    const SA = await insObject(admin, A, 'Staff', { role: 'tech', displayName: 'A · Tech', staffHandle: 'a_tech' });
    const SA2 = await insObject(admin, A, 'Staff', { role: 'front_desk', displayName: 'A · Front' });
    const room = await insObject(admin, A, 'Room', { label: 'Room 3' });
    const task1 = await insObject(admin, A, 'Task', { taskType: 'room_turnover', label: 'Turnover · Room 3' }, 'conflict', 0.5);
    const task2 = await insObject(admin, A, 'Task', { taskType: 'pretest_done' }, null, null);
    await link(admin, A, SA, task1, 'assignedTo');
    await link(admin, A, task1, room, 'references');
    await link(admin, A, SA2, task2, 'assignedTo');

    // Tenant B: staff SB + a task assigned to them.
    const SB = await insObject(admin, B, 'Staff', { displayName: 'B · Manager' });
    const taskB = await insObject(admin, B, 'Task', { taskType: 'equipment_calibration' }, 'pending', 0.5);
    await link(admin, B, SB, taskB, 'assignedTo');

    // ── SA sees only their own task, with room label + verdict passthrough ──
    const mineSA = await repo.listMine(A, ident(A, SA));
    check(mineSA.length === 1 && mineSA[0]!.taskId === task1, 'SA sees exactly their assigned task (not SA2\'s)');
    check(mineSA[0]!.roomLabel === 'Room 3' && mineSA[0]!.label === 'Turnover · Room 3', 'includes linked Room label + task label');
    check(mineSA[0]!.verifiedState === 'conflict' && Math.abs((mineSA[0]!.verificationScore ?? 0) - 0.5) < 1e-9, 'verdict passes through from Task.verified_state (S2)');

    const mineSA2 = await repo.listMine(A, ident(A, SA2));
    check(mineSA2.length === 1 && mineSA2[0]!.taskId === task2, 'SA2 sees only their own task (per-person filter)');

    // ── resolve by dev-shim staffHandle ──
    const byHandle = await repo.listMine(A, { subject: 'dev', tenantId: A, staffHandle: 'a_tech' });
    check(byHandle.length === 1 && byHandle[0]!.taskId === task1, 'resolves the caller by staffHandle (dev shim)');

    // ── cross-tenant isolation ──
    check((await repo.listMine(B, ident(B, SA))).length === 0, "tenant B cannot resolve tenant A's staff → no tasks");
    check((await repo.listMine(A, ident(A, SB))).length === 0, "tenant A cannot see tenant B's staff → no tasks");
    check((await repo.listMine(B, ident(B, SB)))[0]?.taskId === taskB, 'SB sees their own tenant B task');

    // ── no identity → empty ──
    check((await repo.listMine(A, undefined)).length === 0, 'no identity → empty');
    check((await repo.listMine(A, { subject: 'dev', tenantId: A })).length === 0, 'no staffId/handle → empty');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} my-tasks integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
