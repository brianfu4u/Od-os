/**
 * S1-2 integration test: staff report ingest via ReportsRepository against $DATABASE_URL.
 * Proves: report → Communication, sender → provisioned Staff, events-on-change,
 * author + QR-scan reference links, idempotency by clientMessageId (per tenant), and
 * that the same clientMessageId in another tenant is independent. Uses random tenants.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { ReportsRepository } from '../src/reports/reports.repository';
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

async function scalarCount(admin: Client, sql: string, params: unknown[]): Promise<number> {
  const res = await admin.query<{ n: number }>(sql, params);
  return res.rows[0]!.n;
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const repo = new ReportsRepository();
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const A = randomUUID();
  const B = randomUUID();

  try {
    console.log('S1-2 report ingest:');

    const r1 = await repo.ingest(A, {
      clientMessageId: 'm-1',
      reportType: 'clock_in',
      staffHandle: 'openid-a1',
      staffDisplayName: 'A1',
      text: 'on shift',
    });
    check(r1.deduped === false && !!r1.communicationId && !!r1.staffId, 'first ingest creates Communication + Staff');

    const comm = await admin.query<{ properties: Record<string, unknown> }>(
      'SELECT properties FROM objects WHERE id = $1',
      [r1.communicationId],
    );
    const cprops = comm.rows[0]!.properties;
    check(cprops.reportType === 'clock_in' && cprops.authorStaffId === r1.staffId, 'Communication carries reportType + authorStaffId');
    check(cprops.channel === 'wx_miniprogram', 'channel tagged wx_miniprogram');

    const staff = await admin.query<{ properties: Record<string, unknown> }>(
      'SELECT properties FROM objects WHERE id = $1',
      [r1.staffId],
    );
    check(
      staff.rows[0]!.properties.staffHandle === 'openid-a1' && staff.rows[0]!.properties.provisional === true,
      'Staff provisioned by handle',
    );

    check(
      (await scalarCount(admin, `SELECT count(*)::int AS n FROM events WHERE object_id=$1 AND event_type='report.received'`, [r1.communicationId])) === 1,
      'report.received event written',
    );
    check(
      (await scalarCount(admin, `SELECT count(*)::int AS n FROM links WHERE from_object=$1 AND to_object=$2 AND relation='references'`, [r1.communicationId, r1.staffId])) === 1,
      'author reference link created',
    );

    const r1b = await repo.ingest(A, { clientMessageId: 'm-1', reportType: 'clock_in', staffHandle: 'openid-a1' });
    check(r1b.deduped === true && r1b.communicationId === r1.communicationId, 'replay with same clientMessageId dedupes');
    check(
      (await scalarCount(admin, `SELECT count(*)::int AS n FROM objects WHERE tenant_id=$1 AND type='Communication' AND properties->>'clientMessageId'='m-1'`, [A])) === 1,
      'no duplicate Communication for replayed id',
    );

    const r2 = await repo.ingest(A, { clientMessageId: 'm-2', reportType: 'event', staffHandle: 'openid-a1', text: 'pretest queue building' });
    check(r2.staffId === r1.staffId, 'same handle reuses the provisioned Staff');

    const visit = await admin.query<{ id: string }>(
      `INSERT INTO objects (tenant_id, type, properties) VALUES ($1, 'Visit', '{}'::jsonb) RETURNING id`,
      [A],
    );
    const visitId = visit.rows[0]!.id;
    const r3 = await repo.ingest(A, {
      clientMessageId: 'm-3',
      reportType: 'scan',
      staffHandle: 'openid-a1',
      scans: [{ scannedObjectType: 'Visit', scannedObjectId: visitId, at: new Date().toISOString() }],
    });
    check(
      (await scalarCount(admin, `SELECT count(*)::int AS n FROM links WHERE from_object=$1 AND to_object=$2 AND relation='references'`, [r3.communicationId, visitId])) === 1,
      'QR scan creates a references link to the scanned object',
    );

    const rB = await repo.ingest(B, { clientMessageId: 'm-1', reportType: 'clock_in', staffHandle: 'openid-b1' });
    check(rB.deduped === false && rB.communicationId !== r1.communicationId, 'same clientMessageId in another tenant is independent');
  } finally {
    await admin.end();
    await closePool();
  }

  console.log(`\n${failed === 0 ? '✔' : '✖'} reports integration: ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
