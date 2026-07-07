import type { StaffReportInput } from '@clearview/shared';

/**
 * Pure validation of an inbound report (unit-testable without Nest).
 * Returns an error message, or null when the input is acceptable.
 */
export function validateReportInput(input: StaffReportInput | undefined): string | null {
  if (!input || typeof input !== 'object') return 'request body is required';
  if (typeof input.clientMessageId !== 'string' || input.clientMessageId.trim() === '') {
    return 'clientMessageId is required';
  }
  if (typeof input.reportType !== 'string' || input.reportType.trim() === '') {
    return 'reportType is required';
  }
  if (input.attachments && !Array.isArray(input.attachments)) return 'attachments must be an array';
  if (input.scans && !Array.isArray(input.scans)) return 'scans must be an array';
  for (const scan of input.scans ?? []) {
    if (!scan || typeof scan.scannedObjectType !== 'string') {
      return 'each scan requires a scannedObjectType';
    }
  }
  return null;
}
