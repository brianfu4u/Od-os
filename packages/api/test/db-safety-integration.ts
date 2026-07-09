/**
 * S0-3 ops hardening: assertRuntimeRoleSafe() must REFUSE a privileged DB connection
 * (superuser / BYPASSRLS / table owner) and ACCEPT the least-privilege clearview_login.
 * Run against $DATABASE_URL (owner/superuser); the 0007 migration must have created clearview_login.
 */
import 'reflect-metadata';
import { Pool } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { assertRuntimeRoleSafe } from '../src/database/pool';

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
  console.log('S0-3 DB role safety:');

  // 1) The admin/superuser (or table-owner) connection MUST be refused.
  const admin = new Pool({ connectionString: url });
  let refused = false;
  let msg = '';
  try {
    await assertRuntimeRoleSafe(admin);
  } catch (e) {
    refused = true;
    msg = e instanceof Error ? e.message : String(e);
  }
  check(refused, `privileged connection refused (${msg.split('.')[0]})`);
  await admin.end();

  // 2) The least-privilege clearview_login connection MUST pass.
  const u = new URL(url);
  u.username = 'clearview_login';
  u.password = process.env.APP_DB_PASSWORD ?? 'clearview_login_dev';
  const login = new Pool({ connectionString: u.toString() });
  let ok = true;
  try {
    await assertRuntimeRoleSafe(login);
  } catch (e) {
    ok = false;
    console.error('  clearview_login unexpectedly refused:', e instanceof Error ? e.message : e);
  }
  check(ok, 'clearview_login connection passes the safety gate');
  await login.end();

  console.log(`\n${failed === 0 ? '✔' : '✖'} db-safety integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
