/**
 * T-05 · patient-scan integration (embedded Postgres, real RLS).
 *
 * Proves the NEUTRAL contact-event contract end to end at the repository boundary:
 *   - happy (resolved): a scan whose code maps to a Visit backfills patient_visit_id, marks
 *     visit_link_status='resolved', writes an append-only patient_scans row + a `patient.scanned`
 *     event whose payload hard-links scan_id (the Correlator anchor).
 *   - unhappy-but-never-blocked (unresolved): an unknown code is STILL stored raw, with
 *     visit_link_status='unresolved' — a scan is never a dead end (原则 1 + 必改 4).
 *   - silent: the scan carries NO verdict; ScanAck exposes only neutral keys (no verification field).
 *   - isolation: caller id server-resolved; no identity → 403; a Visit in another tenant does NOT
 *     resolve (RLS) → the scan degrades to unresolved rather than cross-tenant leaking.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { ScansRepository, NoStaffIdentityError } from '../src/scans/scans.repository';
import { SensitivePayloadsRepository } from '../src/retention/sensitive-payloads.repository';
import { closePool } from '../src/database/pool';
import type { SessionIdentity } from '../src/auth/session.types';

let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { failed += 1; console.error(`  ✗ ${label}`); }
}

async function insObject(admin: Client, tenant: string, type: string, properties: Record<string, unknown>): Promise<string> {
  const res = await admin.query<{ id: string }>(
    `INSERT INTO objects (tenant_id, type, properties) VALUES ($1,$2,$3::jsonb) RETURNING id`,
    [tenant, type, JSON.stringify(properties)],
  );
  return res.rows[0]!.id;
}
const ident = (tenantId: string, staffId: string): SessionIdentity => ({ subject: 'staff', tenantId, staffId });

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new ScansRepository(new SensitivePayloadsRepository());
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('T-05 patient-scan — resolve, never-block, neutral, isolation:');

    const SA = await insObject(admin, A, 'Staff', { role: 'tech', displayName: 'A · Tech', staffHandle: 'a_tech' });
    const visit = await insObject(admin, A, 'Visit', { code: 'PT-2026-0007', displayName: 'Visit 7' });
    const visitB = await insObject(admin, B, 'Visit', { code: 'PT-B-0001' });

    // ── happy (resolved by business code) ──
    const ack1 = await repo.submitScan(A, ident(A, SA), { patientCode: 'PT-2026-0007', terminalId: 'kiosk-1' });
    check(ack1.visitLinkStatus === 'resolved' && ack1.patientVisitId === visit, 'happy: business code resolves to the Visit id (backfilled)');
    check(ack1.patientCode === 'PT-2026-0007', 'happy: raw code kept verbatim');

    const scanRow = await admin.query<{ id: string; visit_link_status: string; employee_status_at_scan: string | null }>(
      `SELECT id, visit_link_status, employee_status_at_scan FROM patient_scans WHERE id = $1`, [ack1.scanId],
    );
    check(scanRow.rows[0]!.visit_link_status === 'resolved', 'happy: append-only patient_scans row stored (resolved)');

    const ev = await admin.query<{ event_type: string; payload: Record<string, unknown>; object_id: string | null }>(
      `SELECT event_type, payload, object_id FROM events WHERE event_type = 'patient.scanned' AND (payload->>'scanId') = $1 LIMIT 1`, [ack1.scanId],
    );
    check(ev.rows[0]!.event_type === 'patient.scanned', 'happy: emits neutral patient.scanned event');
    check((ev.rows[0]!.payload as { scanId?: string }).scanId === ack1.scanId, 'happy: event payload hard-links scan_id (Correlator anchor)');
    check(ev.rows[0]!.object_id === visit, 'happy: resolved event object_id is the Visit');

    // ── happy (resolved by UUID) ──
    const ack2 = await repo.submitScan(A, ident(A, SA), { patientCode: visit });
    check(ack2.visitLinkStatus === 'resolved' && ack2.patientVisitId === visit, 'happy: a UUID code that names a Visit resolves directly');

    // ── never blocked: unknown code still stored, unresolved ──
    const ack3 = await repo.submitScan(A, ident(A, SA), { patientCode: 'totally-unknown-999' });
    check(ack3.visitLinkStatus === 'unresolved' && ack3.patientVisitId === null, 'never-block: unknown code → unresolved (still stored)');
    check(ack3.patientCode === 'totally-unknown-999', 'never-block: raw unknown code kept verbatim');
    const ev3 = await admin.query(`SELECT object_id FROM events WHERE event_type = 'patient.scanned' AND (payload->>'scanId') = $1 LIMIT 1`, [ack3.scanId]);
    check((ev3.rows[0] as { object_id: string | null }).object_id === null, 'never-block: unresolved event has null object_id (nullable FK)');

    // ── silent / neutral: ScanAck exposes only neutral keys ──
    const KEYS = Object.keys(ack3).sort();
    const ALLOWED = ['employeeId', 'patientCode', 'patientVisitId', 'scanId', 'scannedAt', 'visitLinkStatus'];
    check(JSON.stringify(KEYS) === JSON.stringify(ALLOWED), `neutral: ScanAck keys are exactly ${ALLOWED.join(',')} (no verdict/verification key)`);

    // ── isolation ──
    const byHandle = await repo.submitScan(A, { subject: 'dev', tenantId: A, staffHandle: 'a_tech' }, { patientCode: 'PT-2026-0007' });
    check(byHandle.employeeId === SA, 'isolation: resolves the caller by dev staffHandle');

    // A tenant-B Visit id must NOT resolve for tenant A (RLS) → degrades to unresolved, not a leak.
    const ackCross = await repo.submitScan(A, ident(A, SA), { patientVisitId: visitB });
    check(ackCross.visitLinkStatus === 'unresolved' && ackCross.patientVisitId === null, "isolation: another tenant's Visit id does NOT resolve (RLS) → unresolved");

    let threwNoIdentity = false;
    try { await repo.submitScan(A, { subject: 'dev', tenantId: A }, { patientCode: 'x' }); } catch (e) { threwNoIdentity = e instanceof NoStaffIdentityError; }
    check(threwNoIdentity, 'isolation: no staffId/handle → NoStaffIdentityError (becomes 403)');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} patient-scan integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
