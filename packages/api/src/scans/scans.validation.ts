import type { SubmitScanInput } from '@clearview/shared';

/**
 * Pure input validation for the scan endpoint (unit-testable without Nest).
 * Returns a human-readable error string, or null when the input is acceptable.
 *
 * PRINCIPLE (原则 1 + 必改 4): a scan is NEVER a business rejection. This validator only guards
 * SHAPE, and the ONLY hard requirement is the DB-level invariant `patient_scans_has_key`: at least
 * one of patientCode / patientVisitId must be present. An unresolvable code is NOT an error here —
 * it is persisted as `visit_link_status='unresolved'`. Everything else (terminal, note, attachments,
 * scannedAt) is optional and never blocking.
 */
const MAX_CODE = 512;
const MAX_NOTE = 1000;
const MAX_TERMINAL = 128;
const MAX_ATTACHMENTS = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateSubmitScan(body: Partial<SubmitScanInput> | undefined): string | null {
  if (!body) return 'body is required';

  const code = typeof body.patientCode === 'string' ? body.patientCode.trim() : '';
  const visitId = typeof body.patientVisitId === 'string' ? body.patientVisitId.trim() : '';

  // The single hard rule — mirrors the CHECK constraint. This is input shape, not a verdict.
  if (!code && !visitId) {
    return 'at least one of patientCode / patientVisitId is required';
  }
  if (body.patientCode !== undefined && body.patientCode !== null) {
    if (typeof body.patientCode !== 'string' || body.patientCode.length > MAX_CODE) {
      return `patientCode must be a string of at most ${MAX_CODE} characters`;
    }
  }
  if (visitId && !UUID_RE.test(visitId)) {
    return 'patientVisitId must be a UUID';
  }
  if (body.scannedAt !== undefined && body.scannedAt !== null) {
    if (typeof body.scannedAt !== 'string' || Number.isNaN(Date.parse(body.scannedAt))) {
      return 'scannedAt must be an ISO date string';
    }
  }
  if (body.terminalId !== undefined && body.terminalId !== null) {
    if (typeof body.terminalId !== 'string' || body.terminalId.length > MAX_TERMINAL) {
      return `terminalId must be a string of at most ${MAX_TERMINAL} characters`;
    }
  }
  if (body.optionalNote !== undefined && body.optionalNote !== null) {
    if (typeof body.optionalNote !== 'string' || body.optionalNote.length > MAX_NOTE) {
      return `optionalNote must be a string of at most ${MAX_NOTE} characters`;
    }
  }
  if (body.optionalAttachmentIds !== undefined && body.optionalAttachmentIds !== null) {
    if (!Array.isArray(body.optionalAttachmentIds) || body.optionalAttachmentIds.length > MAX_ATTACHMENTS) {
      return `optionalAttachmentIds must be an array of at most ${MAX_ATTACHMENTS} ids`;
    }
    for (const id of body.optionalAttachmentIds) {
      if (typeof id !== 'string' || !UUID_RE.test(id)) return 'optionalAttachmentIds must all be UUIDs';
    }
  }
  return null;
}
