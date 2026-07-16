/**
 * Employee work-status contract (T-01, feat/business-flow-p0) — shapes shared by api + web.
 *
 * CLAIM vs VERIFICATION discipline (aligned with the flow refactor):
 *   - `claimedStatus` is the CLAIM layer: what the employee declares. Never rejected/blocked.
 *   - `verificationResult` is the VERIFICATION layer: a consistency verdict of claim-vs-evidence.
 *     It is NOT the employee's real status, never overrides the claim, and is NEVER returned to
 *     the employee (manager-side reference only). See 0014_employee_status.sql.
 *
 * Current status is projected onto the Staff object (objects.claimed_state / verified_state);
 * `employee_status_claims` is the append-only claim history, NOT a second employee entity model.
 */

/** The five legal work states (status machine). Stable codes; the UI localises the labels. */
export const EMPLOYEE_STATUSES = ['on_duty', 'busy', 'idle', 'rest', 'off_duty'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** How a claim arrived. Button tap is the norm; the others are reserved. */
export const CLAIM_SOURCES = ['button', 'api', 'system_default'] as const;
export type ClaimSource = (typeof CLAIM_SOURCES)[number];

/**
 * VERIFICATION LAYER: the consistency verdict of a claim against observed evidence.
 * This is deliberately NOT the employee's real status. `null` = not yet checked.
 *
 * NOTE: named `StatusConsistencyResult` (not `VerificationResult`, which is the S2 scorer's shape in
 * verification.contract.ts) so the two verification philosophies never collide. The DB column is
 * `employee_status_claims.verification_result`; this type is its value vocabulary.
 */
export const STATUS_CONSISTENCY_RESULTS = ['consistent', 'inconsistent', 'insufficient_evidence'] as const;
export type StatusConsistencyResult = (typeof STATUS_CONSISTENCY_RESULTS)[number];

/** Type guard: is `v` one of the five legal work states? */
export function isEmployeeStatus(v: unknown): v is EmployeeStatus {
  return typeof v === 'string' && (EMPLOYEE_STATUSES as readonly string[]).includes(v);
}

/** Request body for a status submission. `note` is optional and NEVER blocking. */
export interface SubmitStatusClaimInput {
  /** One of the five legal work states. */
  claimedStatus: EmployeeStatus;
  /** Optional voluntary free-text note left with the status change. */
  note?: string | null;
  /** Optional client timestamp of when the claim was made; server defaults to now(). */
  claimedAt?: string | null;
}

/**
 * EMPLOYEE-FACING projection of the current status.
 *
 * FIELD-PROJECTION GUARANTEE (T-11 asserts this at the key-name level): this shape carries the
 * CLAIM layer ONLY. It MUST NOT contain `verificationResult`, `verificationScore`, any LLM
 * conclusion, or any internal judgment field.
 */
export interface EmployeeStatusView {
  claimedStatus: EmployeeStatus | null;
  note: string | null;
  claimedAt: string | null;
}

/**
 * MANAGER-FACING projection of an employee's status claim. Managers MAY see the verification layer.
 * (Reused by the attention/status-board contracts in T-06/T-09.)
 */
export interface ManagerStatusClaimView {
  employeeId: string;
  claimedStatus: EmployeeStatus | null;
  claimSource: ClaimSource | null;
  /** Consistency verdict; null until a silent background check runs. Manager-side only. */
  verificationResult: StatusConsistencyResult | null;
  verificationScore: number | null;
  note: string | null;
  claimedAt: string | null;
}
