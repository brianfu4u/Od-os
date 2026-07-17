/** T-13B: append-only employee verification ledger, write bridge, RLS, and claim scoping. */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { requireDatabaseUrl } from '../db/env';
import { closePool } from '../src/database/pool';
import { withTenant } from '../src/database/tenant-context';
import { EmployeeStatusVerificationRepository } from '../src/employee-status/employee-status-verification.repository';
import { EmployeeStatusVerificationService } from '../src/employee-status/employee-status-verification.service';

let passed = 0;
let failed = 0;
function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
async function rejects(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
    failed += 1;
    console.error(`  ✗ ${label}`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${label}`);
  }
}

async function main(): Promise<void> {
  const url = requireDatabaseUrl();
  process.env.DATABASE_URL = url;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const service = new EmployeeStatusVerificationService(new EmployeeStatusVerificationRepository());
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const employeeId = randomUUID();
  let firstClaim = '';
  let secondClaim = '';

  try {
    console.log('T-13B employee-status verification ledger:');
    await admin.query(
      `INSERT INTO objects (id, tenant_id, type, properties, claimed_state)
       VALUES ($1, $2, 'Staff', '{}'::jsonb, 'idle')`,
      [employeeId, tenantA],
    );
    const claims = await admin.query<{ id: string }>(
      `INSERT INTO employee_status_claims
         (tenant_id, employee_id, claimed_status, claim_source, claimed_at)
       VALUES ($1, $2, 'busy', 'button', now() - interval '1 minute'),
              ($1, $2, 'idle', 'button', now())
       RETURNING id`,
      [tenantA, employeeId],
    );
    [firstClaim, secondClaim] = claims.rows.map((row) => row.id);

    const receipt = await service.append(tenantA, {
      claimId: firstClaim,
      verificationResult: 'inconsistent',
      verificationScore: 0.59,
      evidence: { eventIds: ['synthetic-event'] },
      reason: 'synthetic deterministic result',
    });
    check(receipt.claimId === firstClaim, 'write bridge appends against the selected claim');

    const own = await withTenant(tenantA, (client) =>
      client.query<{ verification_result: string; verification_score: string }>(
        `SELECT verification_result, verification_score
           FROM employee_status_verification_ledger WHERE id = $1`,
        [receipt.ledgerId],
      ),
    );
    check(
      own.rows[0]?.verification_result === 'inconsistent' &&
        Number(own.rows[0]?.verification_score) === 0.59,
      'employee enum and deterministic verificationScore are stored separately',
    );

    const cross = await withTenant(tenantB, (client) =>
      client.query('SELECT id FROM employee_status_verification_ledger WHERE id = $1', [
        receipt.ledgerId,
      ]),
    );
    check(cross.rowCount === 0, 'RLS hides tenant A ledger rows from tenant B');
    await rejects(
      service.append(tenantB, {
        claimId: firstClaim,
        verificationResult: 'consistent',
        verificationScore: 0.6,
      }),
      'tenant B cannot append a verdict to tenant A claim',
    );

    await rejects(
      admin.query(
        `UPDATE employee_status_verification_ledger
            SET verification_score = 0.6 WHERE id = $1`,
        [receipt.ledgerId],
      ),
      'UPDATE is rejected by append-only trigger',
    );
    await rejects(
      admin.query(`DELETE FROM employee_status_verification_ledger WHERE id = $1`, [
        receipt.ledgerId,
      ]),
      'DELETE is rejected by append-only trigger',
    );

    const latestClaimVerdict = await withTenant(tenantA, (client) =>
      client.query(
        `WITH latest AS (
           SELECT id FROM employee_status_claims
            WHERE employee_id = $1 ORDER BY created_at DESC, claimed_at DESC, id DESC LIMIT 1
         )
         SELECT v.id FROM latest l
         LEFT JOIN employee_status_verification_ledger v ON v.claim_id = l.id`,
        [employeeId],
      ),
    );
    check(
      secondClaim !== firstClaim && latestClaimVerdict.rows[0]?.id == null,
      'a newer claim does not inherit the previous claim verdict',
    );
  } finally {
    await admin.end();
    await closePool();
  }
  console.log(`\n${failed === 0 ? '✔' : '✖'} T-13B ledger — ${passed} passed, ${failed} failed.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
