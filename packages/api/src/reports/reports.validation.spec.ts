import { describe, it, expect } from 'vitest';
import { validateReportInput } from './reports.validation';

describe('validateReportInput', () => {
  it('accepts a minimal valid report', () => {
    expect(validateReportInput({ clientMessageId: 'm1', reportType: 'clock_in' })).toBeNull();
  });

  it('requires clientMessageId and reportType', () => {
    expect(validateReportInput({ reportType: 'event' } as never)).toMatch(/clientMessageId/);
    expect(validateReportInput({ clientMessageId: 'm1' } as never)).toMatch(/reportType/);
    expect(validateReportInput(undefined)).toMatch(/body/);
  });

  it('validates scan shape', () => {
    expect(
      validateReportInput({
        clientMessageId: 'm1',
        reportType: 'scan',
        scans: [{ at: 't' } as never],
      }),
    ).toMatch(/scannedObjectType/);
    expect(
      validateReportInput({
        clientMessageId: 'm1',
        reportType: 'scan',
        scans: [{ scannedObjectType: 'Visit', at: 't' }],
      }),
    ).toBeNull();
  });
});
