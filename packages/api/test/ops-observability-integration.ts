/**
 * feat/ops-observability integration (against $DATABASE_URL). Proves the READ-ONLY ops layer:
 *  - pingDatabase() reports connectivity + latency (drives /health/ready);
 *  - OpsRepository.tenantCounts runs under withTenant/RLS and is TENANT-ISOLATED — a Communication
 *    created in tenant A is counted for A and is INVISIBLE to tenant B;
 *  - OpsService.summary assembles version + db + process metrics + tenant counts, and its serialized
 *    output contains NO secret (a planted token in the error ring never surfaces).
 * Nothing here writes business state beyond a synthetic Communication used to prove the count/RLS.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { requireDatabaseUrl } from '../db/env';
import { withTenant } from '../src/database/tenant-context';
import { pingDatabase, closePool } from '../src/database/pool';
import { OpsRepository } from '../src/ops/ops.repository';
import { OpsService } from '../src/ops/ops.service';
import { metrics } from '../src/ops/metrics.registry';
import { errorSample } from '../src/ops/log';

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
  const repo = new OpsRepository();
  const service = new OpsService(repo);
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('feat/ops-observability:');

    // 1) DB ping (readiness probe).
    const ping = await pingDatabase();
    check(ping.ok === true && typeof ping.latencyMs === 'number', 'pingDatabase reports ok + latency');

    // 2) Seed one synthetic Communication in tenant A (a "report") under RLS.
    await withTenant(A, async (c) => {
      await c.query(`INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Communication', $2::jsonb)`, [
        A,
        JSON.stringify({ text: 'synthetic ops-test report', reportType: 'event' }),
      ]);
    });

    // 3) Tenant counts are scoped to A; B sees none (cross-tenant isolation via RLS).
    const countsA = await repo.tenantCounts(A);
    const countsB = await repo.tenantCounts(B);
    check(countsA.reports >= 1, 'tenant A sees its own report');
    check(countsB.reports === 0, "tenant B does NOT see tenant A's report (RLS isolation)");
    check(countsA.windowHours === 24, 'default 24h window');

    // 4) Summary assembles the expected sections and leaks no secret. Route the error through the
    //    real errorSample() path (what AllExceptionsFilter uses) so this proves scrubbing-before-store.
    metrics.recordError(errorSample(new Error('token=PLANTEDSECRET1234567890 leaked'), { status: 500, route: '/ops/summary' }));
    const summary = await service.summary(A);
    check(!!summary.version && typeof summary.db.ok === 'boolean' && !!summary.metrics && !!summary.tenant, 'summary has version/db/metrics/tenant');
    check(JSON.stringify(summary).indexOf('PLANTEDSECRET1234567890') === -1, 'summary serialization contains NO planted secret (scrubbed)');
  } finally {
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} ops-observability integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
