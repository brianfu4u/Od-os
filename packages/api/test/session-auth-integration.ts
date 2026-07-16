/**
 * S0-3 session auth integration (against $DATABASE_URL). Proves:
 *  - dev-login provisions Staff + openid identity and issues a resolvable session;
 *  - P0-2 sub-issue 1: the DB stores ONLY a SHA-256 token_hash (no raw `token` column), yet the raw
 *    token still authenticates (resolve → identity);
 *  - a bad token resolves to null;
 *  - a report's author is the SESSION's staff — the body's staffHandle is IGNORED (forgery);
 *  - the provisioned staff is tenant-isolated (RLS); manager login binds {tenant, role}.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { SessionStore, hashToken } from '../src/auth/session.store';
import { SessionService } from '../src/auth/session.service';
import { ReportsRepository } from '../src/reports/reports.repository';
import { withTenant } from '../src/database/tenant-context';
import { closePool } from '../src/database/pool';

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

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const sessions = new SessionService(new SessionStore());
  const reports = new ReportsRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('S0-3 session auth:');

    // 1) Dev-login (mock wx.login) provisions staff + issues a session.
    const a = await sessions.devLoginStaff({ tenantId: A, handle: 'front-desk', displayName: 'Front Desk' });
    check(!!a.token && a.identity.subject === 'staff' && a.identity.tenantId === A && !!a.identity.staffId, 'dev-login issues a staff session bound to {tenant, staff}');

    // 2) The session resolves back to the same identity; a bogus token does not. (P0-2 test (b):
    //    the RAW token still authenticates even though only its hash is persisted.)
    const resolved = await sessions.resolve(a.token);
    check(resolved?.tenantId === A && resolved?.staffId === a.identity.staffId, 'session token resolves to the bound identity');
    check((await sessions.resolve('bogus-token')) === null, 'an invalid token resolves to null');

    // 3) Identity + session rows landed in the auth tables.
    const idCount = await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM staff_identities WHERE tenant_id=$1 AND staff_id=$2`, [A, a.identity.staffId]);
    check(idCount.rows[0]!.n === 1, 'staff_identities row created');

    // 3b) P0-2 sub-issue 1 (test (a)): the sessions table has NO raw `token` column — only a
    //     SHA-256 `token_hash`, and the stored value is the hash of the raw token, not the token.
    const rawCol = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='sessions' AND column_name='token'`,
    );
    check(rawCol.rows[0]!.n === 0, 'sessions table has NO raw `token` column (only token_hash)');
    const noRaw = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1 AND tenant_id = $2`,
      [a.token, A],
    );
    check(noRaw.rows[0]!.n === 0, 'the RAW token is never stored (no row matches it verbatim)');
    const byHash = await admin.query<{ token_hash: string }>(
      `SELECT token_hash FROM sessions WHERE token_hash = $1 AND tenant_id = $2`,
      [hashToken(a.token), A],
    );
    check(byHash.rowCount === 1, 'sessions row is stored under the SHA-256 token_hash');
    check(byHash.rows[0]!.token_hash !== a.token, 'stored value is a hash, not the raw token');

    // 4) Re-login with the same handle reuses the same Staff (stable identity).
    const a2 = await sessions.devLoginStaff({ tenantId: A, handle: 'front-desk' });
    check(a2.identity.staffId === a.identity.staffId, 're-login reuses the same provisioned Staff');

    // 5) FORGERY: a report carries a bogus body staffHandle, but the author is the SESSION staff.
    const rep = await reports.ingest(
      A,
      { clientMessageId: 'sess-m1', reportType: 'event', text: 'room ready', staffHandle: 'ceo-impersonator', staffDisplayName: 'Totally The CEO' },
      a.identity,
    );
    check(rep.staffId === a.identity.staffId, 'report author = session staff (body staffHandle ignored)');
    const authored = await admin.query<{ author_staff_id: string }>(
      `SELECT properties->>'authorStaffId' AS author_staff_id FROM objects WHERE id=$1`,
      [rep.communicationId],
    );
    check(authored.rows[0]!.author_staff_id === a.identity.staffId, 'stored authorStaffId is the session staff');
    const impostor = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM objects WHERE type='Staff' AND properties->>'staffHandle'='ceo-impersonator'`,
      [],
    );
    check(impostor.rows[0]!.n === 0, 'no impostor Staff was created from the body handle');

    // 6) Tenant isolation: A's provisioned Staff is invisible under tenant B (RLS).
    const bView = await withTenant(B, async (c) => c.query(`SELECT 1 FROM objects WHERE id=$1`, [a.identity.staffId]));
    check(bView.rowCount === 0, "tenant B cannot see tenant A's staff object (RLS)");

    // 7) Manager dev-login binds {tenant, role}.
    const m = await sessions.devLoginManager({ tenantId: B, login: 'manager@clinic-b', displayName: 'B Manager' });
    check(m.identity.subject === 'manager' && m.identity.tenantId === B && m.identity.role === 'manager' && !!m.identity.managerId, 'manager dev-login binds {tenant, role}');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} session-auth integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
