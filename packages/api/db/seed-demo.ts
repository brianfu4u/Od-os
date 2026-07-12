/**
 * Synthetic demo-clinic seed CLI (feat/demo-seed) — one command that makes the command center +
 * terminal demo-able with believable, PRIVACY-SAFE (no PHI) content. Thin wrapper: env gate +
 * manager credential seed (#26) + the importable core (src/demo/demo-runner). See demo-runner.ts for
 * the moat/RLS/idempotency guarantees (writes claims + evidence only; verdicts derived by real S2).
 *
 * Run: DEMO_SEED=true DEMO_SEED_TENANT_ID=<uuid> \
 *      [MANAGER_SEED_LOGIN=… MANAGER_SEED_PASSWORD=…] [DEMO_SEED_RESET=true] \
 *      pnpm --filter @clearview/api seed:demo
 */
import { loadEnv } from './env';
import { resolveDemoConfig } from '../src/demo/demo-config';
import { runDemoSeed } from '../src/demo/demo-runner';
import { closePool } from '../src/database/pool';
import { SessionService } from '../src/auth/session.service';
import { SessionStore } from '../src/auth/session.store';

async function main(): Promise<void> {
  loadEnv();
  const resolved = resolveDemoConfig(process.env);
  if (!resolved.ok) {
    console.error(`✗ demo seed ${resolved.error}`);
    process.exit(1);
  }
  const { tenantId, reset, manager } = resolved.config;
  console.log(`🌱 demo seed → tenant ${tenantId}${reset ? ' (reset first)' : ''}`);

  try {
    // Manager — reuse the #26 credential seeder so the command center is login-able.
    if (manager) {
      const sessions = new SessionService(new SessionStore());
      const res = await sessions.seedManager({ tenantId, login: manager.login, password: manager.password, displayName: '店长 · Demo', role: 'manager' });
      console.log(`   manager ${res.action}: ${manager.login}`);
    } else {
      console.log('   (no manager seeded — set MANAGER_SEED_LOGIN + MANAGER_SEED_PASSWORD to enable command-center login)');
    }

    const result = await runDemoSeed(tenantId, { reset });
    console.log(`   seeded ${result.seeded} demo object(s)`);
    for (const v of result.verdicts) {
      console.log(`   verify «${v.label}» → ${v.got}${v.skipped ? ' (skipped, already verified)' : ''} [target ${v.target}]`);
    }
    console.log(`\n✔ demo seed complete. Verdicts: ${JSON.stringify(result.tally)}`);
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
