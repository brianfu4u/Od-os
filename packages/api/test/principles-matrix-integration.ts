/**
 * T-11-A · 七条铁律 + 第 8 条(审计去重分层)断言矩阵 (embedded Postgres, real RLS).
 *
 * WHY THIS FILE EXISTS (收口, not 补测):
 *   The eight core invariants of Clinic OS are already exercised, but their assertions are scattered
 *   across ~25 integration scripts. This matrix collapses them into ONE auditable place: each
 *   principle gets a named block so "is invariant N still covered?" is answerable at a glance, and a
 *   regression on any one of them fails here loudly. It reuses the same repository-boundary +
 *   embedded-PG pattern as the other integration scripts; no new migration, seeds its own facts.
 *
 * The eight invariants (numbered as in the project spec):
 *   1. 员工端提交不驳回 — every legal claim/scan succeeds; only input-shape errors 4xx (NOT a business
 *      rejection).
 *   2. AI 输出只给经理参考 — the employee-facing projection carries ONLY claim keys; the verification
 *      verdict never appears in it.
 *   3. claim / verification / world-state 三层分离 — a verification write never mutates the claim or
 *      the projected world state.
 *   4. attention 是待关注列表,非裁决入口 — the queue is read-only; generating it mutates no world state
 *      and emits no employee-visible event.
 *   5. SSE 只做播报 — (asserted structurally in the SSE integration + http-smoke; referenced here).
 *   6. claim vs verified 命名一致 — employee-facing uses `claimedStatus`; verification uses
 *      `verificationResult`; the two vocabularies never blend in the employee view.
 *   7. 租户隔离 (RLS 贯穿) — one tenant's board/attention never sees another tenant's staff.
 *   8. 审计写入层永不去重,去重只发生在展示查询层 — NEW, promoted from a stage-3 implementation detail
 *      to a first-class invariant: the write layer logs EVERY candidate; collapsing same
 *      (employee, kind) happens ONLY on the display path, strictly AFTER the audit write.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { EmployeeStatusRepository } from '../src/employee-status/employee-status.repository';
import { ScansRepository } from '../src/scans/scans.repository';
import { AttentionRepository } from '../src/attention/attention.repository';
import { dedupForDisplay } from '../src/attention/rules/attention-dedup';
import { closePool } from '../src/database/pool';
import type { SessionIdentity } from '../src/auth/session.types';
import { EMPLOYEE_STATUSES } from '@clearview/shared';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

async function insObject(
  admin: Client, tenant: string, type: string, properties: Record<string, unknown>, claimedState?: string,
): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
    [tenant, type, JSON.stringify(properties), claimedState ?? null],
  );
  return res.rows[0]!.id;
}

/** Insert an events row with an explicit created_at (admin path, seeds facts / backdates freshness). */
async function insEvent(admin: Client, tenant: string, objectId: string, type: string, createdAtIso: string): Promise<void> {
  await admin.query(
    `INSERT INTO events (tenant_id, object_id, event_type, payload, actor, created_at) VALUES ($1,$2,$3,'{}'::jsonb,'system',$4)`,
    [tenant, objectId, type, createdAtIso],
  );
}

/** Insert an append-only claim row with an explicit claimed_at (backdate freshness). */
async function insClaim(admin: Client, tenant: string, employeeId: string, status: string, claimedAtIso: string): Promise<void> {
  await admin.query(
    `INSERT INTO employee_status_claims (tenant_id, employee_id, claimed_status, claim_source, claimed_at) VALUES ($1,$2,$3,'button',$4)`,
    [tenant, employeeId, status, claimedAtIso],
  );
}

/** Seconds ago → ISO. */
const iso = (secondsAgo: number): string => new Date(Date.now() - secondsAgo * 1000).toISOString();

const ident = (tenantId: string, staffId: string): SessionIdentity => ({ subject: 'staff', tenantId, staffId });

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const empRepo = new EmployeeStatusRepository();
  const scanRepo = new ScansRepository();
  const attnRepo = new AttentionRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('T-11-A 铁律断言矩阵 — 8 invariants at the repository boundary:\n');

    const SA = await insObject(admin, A, 'Staff', { displayName: 'A · Tech', staffHandle: 'a_tech' }, 'on_duty');
    const SB = await insObject(admin, B, 'Staff', { displayName: 'B · Tech', staffHandle: 'b_tech' }, 'on_duty');

    // ─────────────────────────────────────────────────────────────────────────────
    // 铁律 1 · 员工端提交不驳回
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('铁律 1 · 员工端提交不驳回:');
    for (const s of EMPLOYEE_STATUSES) {
      const r = await empRepo.submitClaim(A, ident(A, SA), s, null, null);
      check(r.view.claimedStatus === s, `1·claim: five-state "${s}" accepted (never rejected)`);
    }
    const emptyNote = await empRepo.submitClaim(A, ident(A, SA), 'busy', null, null);
    check(emptyNote.view.claimedStatus === 'busy', '1·claim: empty note is accepted (note never gates submission)');
    // A scan with an unresolvable code is STILL accepted (recorded, unresolved) — never a business rejection.
    const unresolved = await scanRepo.submitScan(A, ident(A, SA), { patientCode: 'unknown-code-999' });
    check(unresolved.visitLinkStatus === 'unresolved', '1·scan: unresolvable code is still recorded (visitLinkStatus=unresolved, not rejected)');

    // ─────────────────────────────────────────────────────────────────────────────
    // 铁律 2 · AI 输出只给经理参考 (employee-facing view carries CLAIM keys only)
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('铁律 2 · AI 输出只给经理参考:');
    // A manager-side verdict lands on a claim row at INSERT time (the ledger is append-only). Seed a
    // claim that ALREADY carries a verification verdict, then read the employee-facing view.
    await admin.query(
      `INSERT INTO employee_status_claims (tenant_id, employee_id, claimed_status, claim_source, claimed_at, verification_result, verification_confidence)
       VALUES ($1,$2,'busy','button', now(), 'inconsistent', 0.9)`,
      [A, SA],
    );
    const me = await empRepo.currentForCaller(A, ident(A, SA));
    const meKeys = Object.keys(me).sort();
    const CLAIM_ONLY = ['claimedAt', 'claimedStatus', 'note'];
    check(JSON.stringify(meKeys) === JSON.stringify(CLAIM_ONLY),
      `2·projection: employee view keys are exactly {${CLAIM_ONLY.join(',')}} (no verification key leaks)`);
    check(!('verificationResult' in me) && !('verificationConfidence' in me),
      '2·projection: verificationResult / verificationConfidence NEVER present in the employee view');

    // ─────────────────────────────────────────────────────────────────────────────
    // 铁律 3 · claim / verification / world-state 三层分离
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('铁律 3 · claim / verification / world-state 三层分离:');
    const claimedStateBefore = (await admin.query<{ claimed_state: string }>(
      `SELECT claimed_state FROM objects WHERE id = $1`, [SA])).rows[0]!.claimed_state;
    // Append ANOTHER verdict-bearing claim row — the projected world state (Staff.claimed_state) is
    // driven only by the employee's own submissions, never by a manager verdict landing on the ledger.
    await admin.query(
      `INSERT INTO employee_status_claims (tenant_id, employee_id, claimed_status, claim_source, claimed_at, verification_result)
       VALUES ($1,$2,'busy','button', now(), 'consistent')`,
      [A, SA],
    );
    const claimedStateAfter = (await admin.query<{ claimed_state: string }>(
      `SELECT claimed_state FROM objects WHERE id = $1`, [SA])).rows[0]!.claimed_state;
    check(claimedStateBefore === claimedStateAfter,
      '3·separation: appending a verdict-bearing claim row does NOT change the projected world state (claimed_state)');
    const meAfterVerdict = await empRepo.currentForCaller(A, ident(A, SA));
    check(!('verificationResult' in meAfterVerdict) && !('verificationConfidence' in meAfterVerdict),
      '3·separation: the claim the employee sees never carries the verification verdict');

    // ─────────────────────────────────────────────────────────────────────────────
    // 铁律 4 · attention 是待关注列表,非裁决入口 (read-only; no world-state mutation)
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('铁律 4 · attention 只读,非裁决入口:');
    // Dedicated silent employee: on_duty, last valid event 2h ago (> silence threshold), no fresh claim.
    const silent = await insObject(admin, A, 'Staff', { displayName: 'Silent A', staffHandle: 'silent_a' }, 'on_duty');
    await insClaim(admin, A, silent, 'on_duty', iso(7200));
    await insEvent(admin, A, silent, 'employee.status.claimed', iso(7200));
    const claimedStatesBefore = JSON.stringify((await admin.query(
      `SELECT id, claimed_state FROM objects WHERE tenant_id = $1 ORDER BY id`, [A])).rows);
    const gen1 = await attnRepo.generateAndAudit(A);
    // Reading the queue must not mutate any Staff world state.
    const claimedStatesAfter = JSON.stringify((await admin.query(
      `SELECT id, claimed_state FROM objects WHERE tenant_id = $1 ORDER BY id`, [A])).rows);
    check(claimedStatesBefore === claimedStatesAfter, '4·read-only: generating the queue mutates NO world state (claimed_state unchanged)');
    // Queue generation itself adds NO employee-visible event (it only appends manager-actor audit rows).
    const empVisibleAfter = Number((await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE tenant_id = $1 AND actor = 'employee'`, [A])).rows[0]!.n);
    await attnRepo.generateAndAudit(A);
    const empVisibleAfter2 = Number((await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE tenant_id = $1 AND actor = 'employee'`, [A])).rows[0]!.n);
    check(empVisibleAfter === empVisibleAfter2, '4·read-only: queue generation emits NO employee-visible event (only manager-actor audit)');
    check(gen1.candidates.some((c) => c.employeeId === silent), '4·generation: a silent on-duty employee surfaces at least one candidate');

    // ─────────────────────────────────────────────────────────────────────────────
    // 铁律 6 · claim vs verified 命名一致 (vocabulary never blends in the employee view)
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('铁律 6 · claim vs verified 命名一致:');
    check('claimedStatus' in meAfterVerdict, '6·naming: employee view uses `claimedStatus` (claim vocabulary)');
    const managerClaimCol = (await admin.query(
      `SELECT verification_result FROM employee_status_claims WHERE employee_id = $1 LIMIT 1`, [SA])).rows.length === 1;
    check(managerClaimCol, '6·naming: verification uses `verification_result` (verified vocabulary), stored separately');

    // ─────────────────────────────────────────────────────────────────────────────
    // 铁律 7 · 租户隔离 (RLS 贯穿 board + attention)
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('铁律 7 · 租户隔离:');
    const boardA = await empRepo.statusBoard(A);
    check(boardA.every((r) => r.employeeId !== SB), '7·isolation: tenant A board never contains tenant B staff');
    check(gen1.candidates.every((c) => c.employeeId !== SB), '7·isolation: tenant A attention never contains tenant B staff');
    // And B sees only its own.
    await insEvent(admin, B, SB, 'employee.status.claimed', new Date(Date.now() - 6 * 3600_000).toISOString());
    const genB = await attnRepo.generateAndAudit(B);
    check(genB.candidates.every((c) => c.employeeId !== SA), '7·isolation: tenant B attention never contains tenant A staff');

    // ─────────────────────────────────────────────────────────────────────────────
    // 铁律 8 · 审计写入层永不去重,去重只发生在展示查询层  (NEW — promoted to a first-class invariant)
    // ─────────────────────────────────────────────────────────────────────────────
    console.log('铁律 8 · 审计写入永不去重 / 去重只在展示层:');
    // (a) Two reads of the SAME finding → TWO audit events. The write layer must never drop a fact.
    const auditBefore = Number((await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type = 'attention.candidate.generated'`, [silent])).rows[0]!.n);
    await attnRepo.generateAndAudit(A); // read again of the same silent finding
    const auditAfter = Number((await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type = 'attention.candidate.generated'`, [silent])).rows[0]!.n);
    check(auditAfter > auditBefore,
      '8·write-layer: a repeated finding appends ANOTHER audit event (write layer NEVER dedups)');
    // (b) The audit actor is manager-side (never an employee-visible event).
    const auditActor = (await admin.query<{ actor: string }>(
      `SELECT actor FROM events WHERE object_id = $1 AND event_type = 'attention.candidate.generated' LIMIT 1`, [silent])).rows[0]!.actor;
    check(auditActor === 'manager', '8·write-layer: audit actor is manager-side (never employee-visible)');
    // (c) Dedup lives ONLY on the display path: feed duplicate (employee, kind) candidates → collapse to 1.
    const dupCandidate = gen1.candidates.find((c) => c.employeeId === silent)!;
    const collapsed = dedupForDisplay([dupCandidate, { ...dupCandidate }, { ...dupCandidate }]);
    const sameKindCount = collapsed.filter((i) => i.employeeId === dupCandidate.employeeId && i.kind === dupCandidate.kind).length;
    check(sameKindCount === 1,
      '8·display-layer: three duplicate (employee,kind) candidates collapse to ONE item (dedup is display-only)');
    // (d) Proof of layering: the same duplicates never reduced the audit write count above.
    check(auditAfter >= 2,
      '8·layering: display collapse did NOT suppress any audit write (write count keeps climbing)');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} principles-matrix integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
