export const EMPLOYEE_STATUS_VERIFICATION_RESULTS = [
  'consistent',
  'inconsistent',
  'insufficient_evidence',
] as const;

export type EmployeeStatusVerificationResult =
  (typeof EMPLOYEE_STATUS_VERIFICATION_RESULTS)[number];

export interface AppendEmployeeStatusVerification {
  claimId: string;
  verificationResult: EmployeeStatusVerificationResult;
  /** Deterministic rule score. This is never LLM confidence. */
  verificationScore: number | null;
  evidence?: Record<string, unknown>;
  reason?: string | null;
  actor?: 'system_rule' | 'manager';
}

export interface EmployeeStatusVerificationReceipt {
  ledgerId: string;
  claimId: string;
  employeeId: string;
}
