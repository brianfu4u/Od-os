/**
 * T-04 · employee status-claim integration (embedded Postgres, real RLS).
 *
 * Proves the CLAIM-layer contract end to end at the repository boundary:
 *   - happy: a five-state claim writes THREE things atomically — Staff.claimed_state, an append-only
 *     employee_status_claims row, and an `employee.status.claimed` event whose payload hard-links the
 *     claim_id (the Correlator anchor). GET me returns the latest claim.
 *   - silent: writing a manager-side verification_result onto the claim row does NOT change the
 *     employee-facing view — the AI verdict never flows back to the employee (原则 1 + 2).
 *   - projection: the EmployeeStatusView the employee receives contains ONLY claim keys — asserted at
 *     the KEY-NAME level (no verification_result / verification_confidence leak) (T-11 必改 6).
 *   - isolation: the caller's own id is server-resolved (staffId or dev staffHandle); no identity →
 *     403 (NoStaffIdentityError); cross-tenant cannot resolve another tenant's staff.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { EmployeeStatusRepository, NoStaffIdentityError } from '../src/employee-status/employee-status.repository';
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
  const repo = new EmployeeStatusRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('T-04 employee-status — claim layer, silent verdict, projection, isolation:');

    const SA = await insObject(admin, A, 'Staff', { role: 'tech', displayName: 'A · Tech', staffHandle: 'a_tech' });
    const SB = await insObject(admin, B, 'Staff', { displayName: 'B · Tech' });

    // ── happy: submit a five-state claim ──
    const view = await repo.submitClaim(A, ident(A, SA), 'busy', '正在配镜', null);
    check(view.view.claimedStatus === 'busy' && view.view.note === '正在配镜', 'happy: claim returns the submitted status + note');
    check(view.employeeId === SA, 'happy: server-resolved employeeId is the caller');

    // Staff.claimed_state projected.
    const staffRow = await admin.query<{ claimed_state: string | null }>(`SELECT claimed_state FROM objects WHERE id = $1`, [SA]);
    check(staffRow.rows[0]!.claimed_state === 'busy', 'happy: projects onto Staff.claimed_state');

    // Append-only claim row exists.
    const claimRow = await admin.query<{ id: string; claimed_status: string; claim_source: string }>(
      `SELECT id, claimed_status, claim_source FROM employee_status_claims WHERE employee_id = $1 ORDER BY claimed_at DESC LIMIT 1`, [SA],
    );
    check(claimRow.rows[0]!.claimed_status === 'busy' && claimRow.rows[0]!.claim_source === 'button', 'happy: append-only claim row written (source=button)');
    const claimId = claimRow.rows[0]!.id;

    // Event with claim_id hard-link in payload.
    const ev = await admin.query<{ event_type: string; payload: Record<string, unknown>; actor: string }>(
      `SELECT event_type, payload, actor FROM events WHERE object_id = $1 AND event_type = 'employee.status.claimed' ORDER BY created_at DESC LIMIT 1`, [SA],
    );
    check(ev.rows[0]!.event_type === 'employee.status.claimed' && ev.rows[0]!.actor === 'employee', 'happy: emits employee.status.claimed (actor=employee)');
    check((ev.rows[0]!.payload as { claimId?: string }).claimId === claimId, 'happy: event payload hard-links claim_id (Correlator anchor)');

    // GET me returns the latest claim.
    const me1 = await repo.currentForCaller(A, ident(A, SA));
    check(me1.claimedStatus === 'busy', 'happy: GET me returns the latest claim');

    // ── silent: a manager-side verdict must NOT alter the employee-facing view ──
    await admin.query(
      `UPDATE employee_status_claims SET verification_result = 'inconsistent', verification_confidence = 0.91 WHERE id = $1`, [claimId],
    ).catch(() => { /* append-only trigger may block UPDATE — either way the verdict must not surface */ });
    const me2 = await repo.currentForCaller(A, ident(A, SA));
    check(me2.claimedStatus === 'busy', 'silent: employee view unchanged after a manager-side verdict write attempt');

    // ── projection: the view carries ONLY claim keys (key-name whitelist) ──
    const KEYS = Object.keys(me2).sort();
    const ALLOWED = ['claimedAt', 'claimedStatus', 'note'];
    check(JSON.stringify(KEYS) === JSON.stringify(ALLOWED), `projection: EmployeeStatusView keys are exactly ${ALLOWED.join(',')} (no verification leak)`);
    check(!('verificationResult' in me2) && !('verification_result' in me2) && !('verificationConfidence' in me2), 'projection: no verification_result / verification_confidence key present');

    // ── isolation ──
    const byHandle = await repo.submitClaim(A, { subject: 'dev', tenantId: A, staffHandle: 'a_tech' }, 'idle', null, null);
    check(byHandle.employeeId === SA, 'isolation: resolves the caller by dev staffHandle');

    let threwNoIdentity = false;
    try { await repo.currentForCaller(A, { subject: 'dev', tenantId: A }); } catch (e) { threwNoIdentity = e instanceof NoStaffIdentityError; }
    check(threwNoIdentity, 'isolation: no staffId/handle → NoStaffIdentityError (becomes 403)');

    let threwCrossTenant = false;
    try { await repo.currentForCaller(A, ident(A, SB)); } catch (e) { threwCrossTenant = e instanceof NoStaffIdentityError; }
    check(threwCrossTenant, "isolation: tenant A cannot resolve tenant B's staff (RLS) → NoStaffIdentityError");

    // ── T-09 · D1-A: manager whole-roster status board (read-only projection) ──
    // Add a second, NEVER-claimed staff so the board must include "normal" employees too, not only
    // those who ever claimed / surfaced in the attention queue.
    const SA2 = await insObject(admin, A, 'Staff', { displayName: 'A · Front', staffHandle: 'a_front' });

    const boardBefore = await repo.statusBoard(A);
    check(boardBefore.length === 2, 'board: returns EVERY in-roster staff (incl. the never-claimed one)');
    const idsA = boardBefore.map((r) => r.employeeId).sort();
    check(idsA.includes(SA) && idsA.includes(SA2), 'board: whole roster present (claimed + never-claimed)');
    check(!idsA.includes(SB), 'board: tenant A board never contains tenant B staff (RLS isolation)');

    const rowSA = boardBefore.find((r) => r.employeeId === SA)!;
    check(rowSA.claimedStatus === 'idle', 'board: reflects the CLAIM layer (SA last claimed idle via handle)');
    check(rowSA.employeeName === 'A · Tech', 'board: employeeName from displayName');
    const rowSA2 = boardBefore.find((r) => r.employeeId === SA2)!;
    check(rowSA2.claimedStatus === null, 'board: a never-claimed staff shows null claimedStatus (never blocked/hidden)');

    // freshness OBSERVATION is read-time: SA has a valid event (its claims) so secondsSinceLastEvent is
    // a non-negative number; SA2 has no valid event yet so it is null ("stale").
    check(typeof rowSA.secondsSinceLastEvent === 'number' && rowSA.secondsSinceLastEvent! >= 0, 'board: freshness computed read-time for an active staff');
    check(rowSA2.secondsSinceLastEvent === null && rowSA2.lastEventAt === null, 'board: null freshness for a staff with no valid event yet');

    // field-projection guarantee: the board row exposes ONLY claim + observation, never a verdict.
    const BOARD_KEYS = Object.keys(rowSA).sort();
    const BOARD_ALLOWED = ['claimedStatus', 'employeeId', 'employeeName', 'lastEventAt', 'secondsSinceLastEvent'].sort();
    check(JSON.stringify(BOARD_KEYS) === JSON.stringify(BOARD_ALLOWED), `board: row keys are exactly ${BOARD_ALLOWED.join(',')} (no verification/LLM leak)`);
    check(!('verificationResult' in rowSA) && !('verificationConfidence' in rowSA), 'board: no verification_result / verification_confidence key present');

    // read-only guarantee: calling the board twice writes NO event (unlike the attention queue's audit).
    const evBefore = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE tenant_id = $1`, [A]);
    await repo.statusBoard(A);
    await repo.statusBoard(A);
    const evAfter = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM events WHERE tenant_id = $1`, [A]);
    check(evBefore.rows[0]!.n === evAfter.rows[0]!.n, 'board: read-only — two reads append ZERO events (no world-state / audit side-effect)');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} employee-status integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
