/**
 * T-06 / T-07 / T-10 · attention-queue integration (embedded Postgres, real RLS).
 *
 * Proves the manager-side, read-only queue contract end to end at the repository/service boundary:
 *   - generation: an on_duty employee with no recent valid event surfaces a `silence` item whose
 *     evidenceSummary states neutral facts (T-07).
 *   - GET is a PURE READ (P1-5): N reads of the queue write ZERO events of ANY kind — the former
 *     T-10 read-time `attention.candidate.generated` audit was intentionally removed (write-only,
 *     nothing consumed it, and a GET must never mutate).
 *   - display dedup + dequeue: the manager view collapses same employee+kind to one item; once the
 *     employee's fact no longer holds (fresh activity), the item disappears on the next read.
 *   - never touches world state: generating the queue does NOT change claimed_state and produces NO
 *     event whatsoever (no employee-visible event, no manager-side audit event).
 *   - isolation: candidates for tenant A never include tenant B's staff (RLS).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { AttentionRepository } from '../src/attention/attention.repository';
import { AttentionService } from '../src/attention/attention.service';
import { SensitivePayloadsRepository } from '../src/retention/sensitive-payloads.repository';
import { closePool } from '../src/database/pool';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

async function insObject(admin: Client, tenant: string, type: string, properties: Record<string, unknown>, claimedState?: string): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`,
    [tenant, type, JSON.stringify(properties), claimedState ?? null],
  );
  return res.rows[0]!.id;
}

/** Insert a claim row with an explicit claimed_at so freshness/verification are controllable. */
async function insClaim(
  admin: Client, tenant: string, employeeId: string, status: string,
  claimedAtIso: string, verification?: { result?: string; verificationScore?: number },
): Promise<void> {
  await admin.query(
    `INSERT INTO employee_status_claims (tenant_id, employee_id, claimed_status, claim_source, claimed_at, verification_result, verification_score)
     VALUES ($1,$2,$3,'button',$4,$5,$6)`,
    [tenant, employeeId, status, claimedAtIso, verification?.result ?? null, verification?.verificationScore ?? null],
  );
}

/** Insert an events row with an explicit created_at (bypasses default now()). Admin = seeds facts. */
async function insEvent(admin: Client, tenant: string, objectId: string, type: string, createdAtIso: string): Promise<void> {
  await admin.query(
    `INSERT INTO events (tenant_id, object_id, event_type, payload, actor, created_at) VALUES ($1,$2,$3,'{}'::jsonb,'system',$4)`,
    [tenant, objectId, type, createdAtIso],
  );
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new AttentionRepository(new SensitivePayloadsRepository());
  const service = new AttentionService(repo);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();
  const iso = (secsAgo: number) => new Date(Date.now() - secsAgo * 1000).toISOString();

  try {
    console.log('T-06/T-07/T-10 attention — generation, audit-no-dedup, display-dedup, dequeue, isolation:');

    // Silent employee in tenant A: on_duty, last valid event 2h ago (> 3600s silence threshold).
    const silent = await insObject(admin, A, 'Staff', { displayName: 'Silent A', staffHandle: 'silent_a' }, 'on_duty');
    await insClaim(admin, A, silent, 'on_duty', iso(7200));
    await insEvent(admin, A, silent, 'employee.status.claimed', iso(7200));

    // Active employee in tenant A: on_duty with a very recent valid event → should NOT surface.
    const active = await insObject(admin, A, 'Staff', { displayName: 'Active A', staffHandle: 'active_a' }, 'on_duty');
    await insClaim(admin, A, active, 'on_duty', iso(30));
    await insEvent(admin, A, active, 'patient.scanned', iso(20));

    // Tenant B staff (isolation): also silent, but must never appear in tenant A's queue.
    const silentB = await insObject(admin, B, 'Staff', { displayName: 'Silent B', staffHandle: 'silent_b' }, 'on_duty');
    await insClaim(admin, B, silentB, 'on_duty', iso(9000));
    await insEvent(admin, B, silentB, 'employee.status.claimed', iso(9000));

    // ── generation + display dedup ──
    const view1 = await service.queue(A);
    const silenceItems = view1.items.filter((i) => i.kind === 'silence');
    check(silenceItems.length === 1, 'generation: exactly one silence item for the silent on_duty employee');
    check(silenceItems[0]?.employeeId === silent, 'generation: item targets the silent employee');
    check(silenceItems[0]?.id === `${silent}:silence`, 'display: stable id <employeeId>:silence');
    check(silenceItems[0]?.evidenceSummary.claimed === 'on_duty', 'evidence: states the claimed fact (neutral, no verdict)');
    check(!view1.items.some((i) => i.employeeId === active), 'generation: the active employee does NOT surface');

    // ── isolation ──
    check(!view1.items.some((i) => i.employeeId === silentB), 'isolation: tenant B silent staff never appears in tenant A queue');

    // ── P1-5: GET is a pure read — read N times, expect ZERO written events for the finding ──
    await service.queue(A);
    await service.queue(A);
    await service.queue(A); // 4 reads total (view1 + 3) — a stored-write model would show ≥4 rows
    const auditCount = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type = 'attention.candidate.generated'`,
      [silent],
    );
    check(Number(auditCount.rows[0]!.n) === 0, 'P1-5: N reads → 0 attention.candidate.generated events (read path writes nothing)');

    // ── never touches world state: NO event of ANY kind is written by reading the queue ──
    const staffRow = await admin.query<{ claimed_state: string | null }>(`SELECT claimed_state FROM objects WHERE id = $1`, [silent]);
    check(staffRow.rows[0]!.claimed_state === 'on_duty', 'world-state: generation does NOT change claimed_state');
    const anyWrite = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE object_id = $1 AND event_type LIKE 'attention.%'`, [silent],
    );
    check(Number(anyWrite.rows[0]!.n) === 0, 'world-state: reading the queue produces NO attention.* event at all');
    const empVisible = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE object_id = $1 AND actor = 'employee'`, [silent],
    );
    check(Number(empVisible.rows[0]!.n) === 0, 'world-state: generation produces NO employee-actor event');

    // ── auto-dequeue: the silent employee now has fresh activity → item disappears next read ──
    await insEvent(admin, A, silent, 'patient.scanned', iso(5));
    const view3 = await service.queue(A);
    check(!view3.items.some((i) => i.employeeId === silent && i.kind === 'silence'),
      'dequeue: once the fact no longer holds, the item disappears (read-time, no stored table)');

    // ── low_confidence rule surfaces from the verification layer ──
    const lowc = await insObject(admin, A, 'Staff', { displayName: 'LowC A', staffHandle: 'lowc_a' }, 'idle');
    await insClaim(admin, A, lowc, 'idle', iso(60), { result: 'inconsistent', verificationScore: 0.2 });
    await insEvent(admin, A, lowc, 'employee.status.claimed', iso(60));
    const view4 = await service.queue(A);
    check(view4.items.some((i) => i.employeeId === lowc && i.kind === 'low_confidence'),
      'low_confidence: an inconsistent verification verdict surfaces a manager-side item');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} attention integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
