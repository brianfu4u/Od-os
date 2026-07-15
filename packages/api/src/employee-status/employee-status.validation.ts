import type { SubmitStatusClaimInput } from '@clearview/shared';
import { isEmployeeStatus } from '@clearview/shared';

/**
 * Pure input validation for the employee status-claim endpoint (unit-testable without Nest).
 * Returns a human-readable error string, or null when the input is acceptable.
 *
 * IMPORTANT (原则 1): a well-formed five-state claim is NEVER a "business rejection". This validator
 * only guards SHAPE — an unknown status code or a malformed timestamp is a 400 input error, not an
 * evaluative judgement of the employee. The optional `note` is never required and never blocking.
 */
const MAX_NOTE = 1000;

export function validateSubmitStatusClaim(body: Partial<SubmitStatusClaimInput> | undefined): string | null {
  if (!body) return 'body is required';
  if (!isEmployeeStatus(body.claimedStatus)) {
    return "claimedStatus must be one of 'on_duty' | 'busy' | 'idle' | 'rest' | 'off_duty'";
  }
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE) {
      return `note must be a string of at most ${MAX_NOTE} characters`;
    }
  }
  if (body.claimedAt !== undefined && body.claimedAt !== null) {
    if (typeof body.claimedAt !== 'string' || Number.isNaN(Date.parse(body.claimedAt))) {
      return 'claimedAt must be an ISO date string';
    }
  }
  return null;
}

/** Normalize a status-claim input: keep the status, trim/drop empty optionals. */
export function normalizeStatusClaim(body: SubmitStatusClaimInput): {
  claimedStatus: SubmitStatusClaimInput['claimedStatus'];
  note: string | null;
  claimedAt: string | null;
} {
  return {
    claimedStatus: body.claimedStatus,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
    claimedAt: typeof body.claimedAt === 'string' && body.claimedAt.trim() ? body.claimedAt.trim() : null,
  };
}
