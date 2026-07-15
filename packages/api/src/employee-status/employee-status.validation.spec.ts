import { describe, it, expect } from 'vitest';
import { validateSubmitStatusClaim, normalizeStatusClaim } from './employee-status.validation';

describe('validateSubmitStatusClaim', () => {
  it('accepts each of the five states', () => {
    for (const s of ['on_duty', 'busy', 'idle', 'rest', 'off_duty'] as const) {
      expect(validateSubmitStatusClaim({ claimedStatus: s })).toBeNull();
    }
  });

  it('rejects a missing body or an unknown status (input shape, NOT a business rejection)', () => {
    expect(validateSubmitStatusClaim(undefined)).toMatch(/body/);
    expect(validateSubmitStatusClaim({})).toMatch(/claimedStatus/);
    expect(validateSubmitStatusClaim({ claimedStatus: 'lunch' as never })).toMatch(/claimedStatus/);
  });

  it('accepts an optional note within the cap and a valid ISO claimedAt', () => {
    expect(validateSubmitStatusClaim({ claimedStatus: 'busy', note: '正在配镜' })).toBeNull();
    expect(validateSubmitStatusClaim({ claimedStatus: 'busy', claimedAt: '2026-07-15T09:00:00Z' })).toBeNull();
    expect(validateSubmitStatusClaim({ claimedStatus: 'busy', note: null, claimedAt: null })).toBeNull();
  });

  it('rejects an over-long note or a malformed claimedAt', () => {
    expect(validateSubmitStatusClaim({ claimedStatus: 'busy', note: 'x'.repeat(1001) })).toMatch(/note/);
    expect(validateSubmitStatusClaim({ claimedStatus: 'busy', claimedAt: 'nope' })).toMatch(/claimedAt/);
  });
});

describe('normalizeStatusClaim', () => {
  it('trims a note and drops empties to null', () => {
    expect(normalizeStatusClaim({ claimedStatus: 'idle', note: '  hi  ' })).toEqual({
      claimedStatus: 'idle',
      note: 'hi',
      claimedAt: null,
    });
    expect(normalizeStatusClaim({ claimedStatus: 'idle', note: '   ' }).note).toBeNull();
  });
});
