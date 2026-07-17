import { Injectable } from '@nestjs/common';
import { withTenant } from '../database/tenant-context';
import type {
  AppendEmployeeStatusVerification,
  EmployeeStatusVerificationReceipt,
} from './employee-status-verification.types';

/** T-13B append-only write bridge. It evaluates no evidence and contains no business classifier. */
@Injectable()
export class EmployeeStatusVerificationRepository {
  async append(
    tenantId: string,
    input: AppendEmployeeStatusVerification,
  ): Promise<EmployeeStatusVerificationReceipt> {
    return withTenant(tenantId, async (client) => {
      const result = await client.query<{
        id: string;
        claim_id: string;
        employee_id: string;
      }>(
        `INSERT INTO employee_status_verification_ledger (
           tenant_id, claim_id, employee_id, verification_result, verification_score,
           evidence, reason, actor
         )
         SELECT $1, c.id, c.employee_id, $3, $4, $5::jsonb, $6, $7
           FROM employee_status_claims c
          WHERE c.id = $2
         RETURNING id, claim_id, employee_id`,
        [
          tenantId,
          input.claimId,
          input.verificationResult,
          input.verificationScore,
          JSON.stringify(input.evidence ?? {}),
          input.reason ?? null,
          input.actor ?? 'system_rule',
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('employee status claim not found');
      return { ledgerId: row.id, claimId: row.claim_id, employeeId: row.employee_id };
    });
  }
}
