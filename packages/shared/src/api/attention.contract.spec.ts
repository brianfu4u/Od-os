import { describe, it, expect } from 'vitest';
import { maskScanCode } from './attention.contract';

describe('maskScanCode (P1-6-f)', () => {
  it('keeps the prefix through the first dash and masks the rest', () => {
    expect(maskScanCode('PT-7')).toBe('PT-****');
    expect(maskScanCode('PT-000123')).toBe('PT-****');
    expect(maskScanCode('VISIT-abc-def')).toBe('VISIT-****');
  });

  it('keeps the first two chars when there is no dash', () => {
    expect(maskScanCode('ABC12345')).toBe('AB****');
    expect(maskScanCode('X9')).toBe('X9****');
  });

  it('never returns the full raw value', () => {
    for (const raw of ['PT-7', 'ABC12345', 'PATIENT-999']) {
      expect(maskScanCode(raw)).not.toBe(raw);
    }
  });

  it('returns null for null / undefined / empty', () => {
    expect(maskScanCode(null)).toBeNull();
    expect(maskScanCode(undefined)).toBeNull();
    expect(maskScanCode('')).toBeNull();
  });
});
