/**
 * P1-6-f · attention queue scan-code masking + audited reveal (embedded Postgres).
 *
 * Proves:
 *   - GET /attention/queue (service.queue) returns the scan code MASKED (`PT-****`) with
 *     revealable=true, and the raw code never appears anywhere in the queue view;
 *   - reading the queue writes ZERO events — including no `sensitive.raw.accessed` (P1-5 invariant:
 *     a GET must never mutate; the access event belongs on the reveal WRITE, not the read);
 *   - POST /attention/reveal-scan-code (repo.revealScanCode) returns the FULL code + scanAt and
 *     appends exactly ONE `sensitive.raw.accessed` access event whose payload does NOT copy the raw
 *     content (who/when only), with actor = the manager id;
 *   - the reveal event_type is OUTSIDE the freshness whitelist (does not refresh employee_freshness);
 *   - absent case: a staff with no scan → { scanCode:null, reason:'absent' } (200-shaped, still audited);
 *   - tenant isolation: a reveal scoped to tenant A cannot read tenant B's scan code (RLS).
 *
 * P1-6-d · D-choice-1 read-path closure (updated): reveal now resolves the raw code from the
 * redactable side-store (sensitive_payloads), NOT the append-only patient_scans.patient_code column
 * (KI-001). So this test mirrors the code into the side-store (as P1-6-b dual-write / P1-6-d backfill
 * would) to get a full reveal, and additionally proves that a scan whose side-store copy is REDACTED
 * (or was never mirrored) reveals as { scanCode:null, reason:'redacted' } even though the plaintext
 * still physically exists in the source column.
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

async function insObject(admin: Client, tenant: string, props: Record<string, unknown>, claimed?: string): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties, claimed_state) VALUES ($1,'Staff',$2::jsonb,$3) RETURNING id`,
    [tenant, JSON.stringify(props), claimed ?? null],
  );
  return r.rows[0]!.id;
}

/** Seed a scan with an explicit scanned_at (seconds ago) so scan_no_followup can be driven. */
async function insScan(admin: Client, tenant: string, employeeId: string, code: string, secsAgo: number): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `INSERT INTO patient_scans (tenant_id, employee_id, patient_code, scanned_at)
     VALUES ($1,$2,$3, now() - make_interval(secs => $4)) RETURNING id`,
    [tenant, employeeId, code, secsAgo],
  );
  return r.rows[0]!.id;
}

/** Mirror the scan's raw code into the redactable side-store (as P1-6-b dual-write / -d backfill do). */
async function mirrorScanCode(admin: Client, tenant: string, scanId: string, code: string): Promise<void> {
  await admin.query(
    `INSERT INTO sensitive_payloads (tenant_id, source_table, source_id, field, content)
     VALUES ($1, 'patient_scans', $2, 'patient_code', $3)`,
    [tenant, scanId, code],
  );
}

/** Redact a side-store payload (as the retention sweep does): content → NULL, stamp redacted_at. */
async function redactScanCode(admin: Client, tenant: string, scanId: string): Promise<void> {
  await admin.query(
    `UPDATE sensitive_payloads SET content = NULL, redacted_at = now()
      WHERE tenant_id = $1 AND source_table = 'patient_scans' AND source_id = $2 AND field = 'patient_code'`,
    [tenant, scanId],
  );
}

function accessEventCount(admin: Client, staffId: string): Promise<number> {
  return admin
    .query<{ n: string }>(
      `SELECT count(*)::int AS n FROM events WHERE object_id = $1 AND event_type = 'sensitive.raw.accessed'`,
      [staffId],
    )
    .then((r) => Number(r.rows[0]!.n));
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
  const MGR = randomUUID();
  const RAW = 'PT-SECRET-42';

  try {
    console.log('P1-6-f reveal — queue masking + audited reveal:');

    // Tenant A: a staff who scanned but never followed up → scan_no_followup fires with the code.
    const staff = await insObject(admin, A, { displayName: 'Tech A', staffHandle: 'tech_a' }, 'on_duty');
    const scanId = await insScan(admin, A, staff, RAW, 3600); // 1h ago, > 1800s follow-up window, no progress after
    await mirrorScanCode(admin, A, scanId, RAW); // P1-6-b/-d: raw code lives in the redactable side-store

    // Tenant A: a staff whose scan's side-store copy is REDACTED (retention swept) → reveal must NOT
    // fall back to the still-present plaintext source column (P1-6-d read-path closure, KI-001).
    const redStaff = await insObject(admin, A, { displayName: 'Redacted', staffHandle: 'red_staff' }, 'on_duty');
    const redScan = await insScan(admin, A, redStaff, 'PT-REDACTED-7', 3600);
    await mirrorScanCode(admin, A, redScan, 'PT-REDACTED-7');
    await redactScanCode(admin, A, redScan); // sweep redacts the side-store copy; source column untouched

    // Tenant A: a staff with NO scan → the absent path.
    const noScan = await insObject(admin, A, { displayName: 'No Scan', staffHandle: 'no_scan' }, 'on_duty');

    // Tenant B: a staff with a scan — must be invisible to a tenant-A-scoped reveal (RLS).
    const staffB = await insObject(admin, B, { displayName: 'Tech B', staffHandle: 'tech_b' }, 'on_duty');
    const scanB = await insScan(admin, B, staffB, 'PT-B-ONLY-99', 3600);
    await mirrorScanCode(admin, B, scanB, 'PT-B-ONLY-99');

    // ── queue masking ──
    const view = await service.queue(A);
    const item = view.items.find((i) => i.employeeId === staff && i.kind === 'scan_no_followup');
    check(!!item, 'queue: scan_no_followup item surfaces for the un-followed-up scan');
    check(item?.evidenceSummary.submitted === 'PT-****', `queue: scan code is MASKED (got ${item?.evidenceSummary.submitted})`);
    check(item?.evidenceSummary.revealable === true, 'queue: masked item is flagged revealable');
    check(!JSON.stringify(view).includes(RAW), 'queue: the RAW scan code never appears anywhere in the queue view');

    // ── P1-5 invariant: reading the queue writes NO event, including no access event ──
    await service.queue(A);
    await service.queue(A); // several reads
    check((await accessEventCount(admin, staff)) === 0, 'P1-5: reading the queue writes ZERO sensitive.raw.accessed events (GET never mutates)');

    // ── reveal (the WRITE path) ──
    const revealed = await repo.revealScanCode(A, staff, MGR);
    check(revealed.scanCode === RAW, `reveal: returns the FULL raw code (got ${revealed.scanCode})`);
    check(typeof revealed.scanAt === 'string' && revealed.scanAt !== null, 'reveal: returns scanAt');
    check(revealed.reason === undefined, 'reveal: no reason when a code is present');
    check((await accessEventCount(admin, staff)) === 1, 'reveal: appends exactly ONE sensitive.raw.accessed event');

    const ev = await admin.query<{ payload: Record<string, unknown>; actor: string | null }>(
      `SELECT payload, actor FROM events WHERE object_id = $1 AND event_type = 'sensitive.raw.accessed' ORDER BY created_at DESC LIMIT 1`,
      [staff],
    );
    check(ev.rows[0]!.actor === MGR, 'reveal event: actor = the manager id (who viewed the raw value)');
    check(!JSON.stringify(ev.rows[0]!.payload).includes(RAW), 'reveal event: payload does NOT copy the raw content (who/when only, no second copy)');
    check((ev.rows[0]!.payload as { field?: string }).field === 'patient_code', 'reveal event: payload records the field accessed');

    // a second reveal appends another event (each view is independently audited)
    await repo.revealScanCode(A, staff, MGR);
    check((await accessEventCount(admin, staff)) === 2, 'reveal: each reveal is independently audited (2 events after 2 reveals)');

    // ── reveal must NOT refresh freshness (event_type outside the 0016 whitelist) ──
    const fresh = await admin.query<{ whitelisted: boolean }>(
      `SELECT 'sensitive.raw.accessed' = ANY(freshness_valid_event_types()) AS whitelisted`,
    );
    check(fresh.rows[0]!.whitelisted === false, 'reveal event_type is OUTSIDE the freshness whitelist (never refreshes freshness)');

    // ── absent case ──
    const absent = await repo.revealScanCode(A, noScan, MGR);
    check(absent.scanCode === null && absent.reason === 'absent', 'absent: no scan → { scanCode:null, reason:absent } (200-shaped, not 404)');
    check((await accessEventCount(admin, noScan)) === 1, 'absent: the attempt is still audited (one access event)');

    // ── P1-6-d redacted case: side-store copy swept → reveal returns redacted, NOT the source plaintext ──
    const redResult = await repo.revealScanCode(A, redStaff, MGR);
    check(redResult.scanCode === null && redResult.reason === 'redacted', 'redacted: swept side-store copy → { scanCode:null, reason:redacted } (source column NOT read)');
    check(!JSON.stringify(redResult).includes('PT-REDACTED-7'), 'redacted: the plaintext still in the source column never leaks through reveal (D-choice-1 / KI-001)');
    // confirm the plaintext DOES still physically exist in the append-only source column (KI-001 residual)
    const srcStill = await admin.query<{ patient_code: string | null }>(
      `SELECT patient_code FROM patient_scans WHERE id = $1`, [redScan],
    );
    check(srcStill.rows[0]!.patient_code === 'PT-REDACTED-7', 'KI-001: source column plaintext is intentionally still present (append-only), but unreachable via the API');
    check((await accessEventCount(admin, redStaff)) === 1, 'redacted: the reveal attempt is still audited');

    // ── tenant isolation: reveal scoped to A cannot read B's scan → treated as absent ──
    const crossTenant = await repo.revealScanCode(A, staffB, MGR);
    check(crossTenant.scanCode === null, "isolation: tenant-A reveal cannot read tenant B's scan code (RLS)");
    check(!JSON.stringify(crossTenant).includes('PT-B-ONLY-99'), "isolation: tenant B's code never leaks through a tenant-A reveal");
  } finally {
    // events / patient_scans / objects are append-only (0003 forbid_mutation trigger); bypass the
    // trigger ONLY for test cleanup by temporarily disabling triggers (owner), then restore.
    await admin.query("SET session_replication_role = 'replica'");
    await admin.query(`DELETE FROM events WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
    await admin.query(`DELETE FROM sensitive_payloads WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
    await admin.query(`DELETE FROM patient_scans WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
    await admin.query(`DELETE FROM objects WHERE tenant_id = ANY($1::uuid[])`, [[A, B]]);
    await admin.query("SET session_replication_role = 'origin'");
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} reveal integration: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

void main();
