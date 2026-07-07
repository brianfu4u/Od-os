import { describe, it, expect } from 'vitest';
import { isUuid, headerTenantAllowed } from './tenant.guard';

describe('isUuid', () => {
  it('accepts valid UUIDs', () => {
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isUuid('a56154b9-8149-4f35-8040-602cf4371ca5')).toBe(true);
  });
  it('rejects non-UUIDs', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid('')).toBe(false);
    expect(isUuid(undefined)).toBe(false);
    expect(isUuid(12345)).toBe(false);
  });
});

describe('headerTenantAllowed', () => {
  it('permits the header stand-in only outside production', () => {
    expect(headerTenantAllowed('development')).toBe(true);
    expect(headerTenantAllowed('test')).toBe(true);
    expect(headerTenantAllowed(undefined)).toBe(true);
    expect(headerTenantAllowed('production')).toBe(false);
  });
});
