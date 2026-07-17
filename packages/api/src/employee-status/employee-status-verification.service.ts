import { Injectable } from '@nestjs/common';
import { EmployeeStatusVerificationRepository } from './employee-status-verification.repository';
import {
  EMPLOYEE_STATUS_VERIFICATION_RESULTS,
  type AppendEmployeeStatusVerification,
  type EmployeeStatusVerificationReceipt,
} from './employee-status-verification.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_KEYS = new Set([
  'claimId',
  'verificationResult',
  'verificationScore',
  'evidence',
  'reason',
  'actor',
]);

/** Strict internal bridge. A future classifier may call it; this ticket deliberately supplies none. */
@Injectable()
export class EmployeeStatusVerificationService {
  constructor(private readonly repository: EmployeeStatusVerificationRepository) {}

  append(
    tenantId: string,
    input: AppendEmployeeStatusVerification,
  ): Promise<EmployeeStatusVerificationReceipt> {
    if (!input || typeof input !== 'object') throw new TypeError('invalid verification input');
    for (const key of Object.keys(input)) {
      if (!ALLOWED_KEYS.has(key)) throw new TypeError(`unknown verification field: ${key}`);
    }
    if (!UUID.test(input.claimId)) throw new TypeError('invalid claimId');
    if (!EMPLOYEE_STATUS_VERIFICATION_RESULTS.includes(input.verificationResult)) {
      throw new TypeError('invalid employee-status verificationResult');
    }
    if (
      input.verificationScore !== null &&
      (typeof input.verificationScore !== 'number' ||
        !Number.isFinite(input.verificationScore) ||
        input.verificationScore < 0 ||
        input.verificationScore > 1)
    ) {
      throw new TypeError('verificationScore must be a finite number in [0,1]');
    }
    if (input.actor !== undefined && input.actor !== 'system_rule' && input.actor !== 'manager') {
      throw new TypeError('invalid verification actor');
    }
    return this.repository.append(tenantId, input);
  }
}
