import { describe, it, expect } from 'vitest';
import { validateSubmitScan } from './scans.validation';

const U = '11111111-1111-1111-1111-111111111111';

describe('validateSubmitScan', () => {
  it('accepts a scan with only a raw code, or only a visit id, or both', () => {
    expect(validateSubmitScan({ patientCode: 'PT-2026-0007' })).toBeNull();
    expect(validateSubmitScan({ patientVisitId: U })).toBeNull();
    expect(validateSubmitScan({ patientCode: 'PT-1', patientVisitId: U })).toBeNull();
  });

  it('enforces the at-least-one-key rule (mirrors the DB CHECK — input shape, not a verdict)', () => {
    expect(validateSubmitScan(undefined)).toMatch(/body/);
    expect(validateSubmitScan({})).toMatch(/at least one/);
    expect(validateSubmitScan({ patientCode: '   ', patientVisitId: '  ' })).toMatch(/at least one/);
  });

  it('does NOT reject an unresolvable code (that becomes visit_link_status=unresolved downstream)', () => {
    expect(validateSubmitScan({ patientCode: 'totally-unknown-code' })).toBeNull();
  });

  it('validates optional fields but never requires them', () => {
    expect(validateSubmitScan({ patientCode: 'x', patientVisitId: 'not-a-uuid' })).toMatch(/patientVisitId/);
    expect(validateSubmitScan({ patientCode: 'x', scannedAt: 'nope' })).toMatch(/scannedAt/);
    expect(validateSubmitScan({ patientCode: 'x', terminalId: 't'.repeat(129) })).toMatch(/terminalId/);
    expect(validateSubmitScan({ patientCode: 'x', optionalNote: 'n'.repeat(1001) })).toMatch(/optionalNote/);
    expect(validateSubmitScan({ patientCode: 'x', optionalAttachmentIds: ['nope'] })).toMatch(/UUID/);
    expect(
      validateSubmitScan({ patientCode: 'x', scannedAt: '2026-07-15T09:00:00Z', terminalId: 'kiosk-1', optionalNote: 'ok', optionalAttachmentIds: [U] }),
    ).toBeNull();
  });
});
