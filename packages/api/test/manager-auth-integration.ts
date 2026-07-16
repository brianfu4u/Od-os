/**
 * feat/manager-auth integration (against $DATABASE_URL). Proves the REAL manager credential login:
 *  - seedManager provisions a manager + stores a scrypt hash (NEVER plaintext);
 *  - loginManager succeeds with the right password and binds {tenant, manager, role};
 *  - wrong password / unknown login are rejected (generic 401);
 *  - seeding is idempotent (skips an existing credential) and rotatable (force sets a new one);
 *  - the manager's session is tenant-bound and its Staff object is invisible to another tenant (RLS);
 *  - the role policy admits a manager and denies a staff on a manager-only route (403 semantics).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { SessionStore } from '../src/auth/session.store';
import { SessionService } from '../src/auth/session.service';
import { verifyPassword } from '../src/auth/password';
import { identityMeetsRoles } from '../src/tenant/roles.policy';
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
async function rejects(p: Promise<unknown>, label: string): Promise<void> {
  try {
    await p;
    failed += 1;
    console.error(`  ✗ ${label} (expected rejection)`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const store = new SessionStore();
  const sessions = new SessionService(store);
  const admin = new Client({ connectionString: url });
  await admin.connect();

  const A = randomUUID();
  const B = randomUUID();
  const login = `manager+${A.slice(0, 8)}@clinic-a`;
  const PW = 'a-strong-manager-password';

  try {
    console.log('feat/manager-auth:');

    // 1) Seed a manager with a credential.
    const seeded = await sessions.seedManager({ tenantId: A, login, password: PW, displayName: 'Dana · Manager' });
    check(seeded.action === 'created' && !!seeded.managerId, 'seedManager provisions a new manager (created)');

    // 2) The stored hash is a scrypt encoding, NOT the plaintext.
    const row = await admin.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM manager_identities WHERE login=$1`,
      [login],
    );
    const hash = row.rows[0]?.password_hash ?? '';
    check(hash.startsWith('scrypt$'), 'password stored as a scrypt hash');
    check(!hash.includes(PW), 'stored hash does NOT contain the plaintext password');
    check(await verifyPassword(PW, hash), 'stored hash verifies the correct password');

    // 3) Correct login → manager session bound to {tenant, manager, role}.
    const ok = await sessions.loginManager({ login, password: PW });
    check(
      ok.identity.subject === 'manager' && ok.identity.tenantId === A && ok.identity.role === 'manager' && !!ok.identity.managerId,
      'loginManager issues a manager session bound to {tenant, role}',
    );
    const resolved = await sessions.resolve(ok.token);
    check(resolved?.tenantId === A && resolved?.managerId === ok.identity.managerId, 'session resolves back to the manager identity');

    // 4) Wrong password / unknown login → rejected (generic 401).
    await rejects(sessions.loginManager({ login, password: 'WRONG-password' }), 'wrong password rejected');
    await rejects(sessions.loginManager({ login: 'no-such-login@nowhere', password: PW }), 'unknown login rejected');

    // 5) Idempotent: re-seed WITHOUT force leaves the existing credential intact (skipped).
    const again = await sessions.seedManager({ tenantId: A, login, password: 'different-would-be-pw' });
    check(again.action === 'skipped', 're-seed without force is skipped (idempotent)');
    check((await sessions.loginManager({ login, password: PW })).identity.managerId === ok.identity.managerId, 'original password still works after skipped re-seed');

    // 6) Rotation: force re-seed sets a NEW password; the old one stops working.
    const NEWPW = 'rotated-manager-password';
    const rot = await sessions.seedManager({ tenantId: A, login, password: NEWPW, force: true });
    check(rot.action === 'updated', 'force re-seed rotates the credential (updated)');
    check((await sessions.loginManager({ login, password: NEWPW })).identity.tenantId === A, 'new password works after rotation');
    await rejects(sessions.loginManager({ login, password: PW }), 'old password no longer works after rotation');

    // 7) Role policy: manager admitted, staff denied on a manager-only route.
    check(identityMeetsRoles(ok.identity, ['manager'], 'production') === true, 'role policy: manager admitted to manager route');
    const staff = await sessions.devLoginStaff({ tenantId: A, handle: 'nurse-a' });
    check(identityMeetsRoles(staff.identity, ['manager'], 'production') === false, 'role policy: staff denied on manager route (→403)');

    // 8) Tenant isolation: the manager's Staff object is invisible under another tenant (RLS).
    const bView = await withTenant(B, async (c) => c.query(`SELECT 1 FROM objects WHERE id=$1`, [seeded.managerId]));
    check(bView.rowCount === 0, "tenant B cannot see tenant A's manager Staff object (RLS)");
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} manager-auth integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
