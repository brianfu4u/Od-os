import { describe, it, expect } from 'vitest';
import { parseSeedConfig } from './manager-seed.config';

const TENANT = '11111111-1111-1111-1111-111111111111';

describe('parseSeedConfig — env-gated, well-formed-or-null', () => {
  it('returns null when seeding is not requested (dev/CI default)', () => {
    expect(parseSeedConfig({})).toBeNull();
    expect(parseSeedConfig({ MANAGER_SEED_LOGIN: 'dana' })).toBeNull(); // no password/tenant
    expect(parseSeedConfig({ MANAGER_SEED_LOGIN: 'dana', MANAGER_SEED_PASSWORD: 'pw' })).toBeNull(); // no tenant
  });

  it('returns null for an invalid tenant uuid', () => {
    expect(parseSeedConfig({ MANAGER_SEED_LOGIN: 'dana', MANAGER_SEED_PASSWORD: 'pw', MANAGER_SEED_TENANT_ID: 'nope' })).toBeNull();
  });

  it('parses a valid trio, trims, and applies defaults', () => {
    const cfg = parseSeedConfig({ MANAGER_SEED_LOGIN: '  dana  ', MANAGER_SEED_PASSWORD: 'a-strong-seed-pw', MANAGER_SEED_TENANT_ID: TENANT });
    expect(cfg).toEqual({ tenantId: TENANT, login: 'dana', password: 'a-strong-seed-pw', displayName: undefined, role: 'manager', force: false });
  });

  it('honors role, force, and displayName overrides', () => {
    const cfg = parseSeedConfig({
      MANAGER_SEED_LOGIN: 'dana',
      MANAGER_SEED_PASSWORD: 'a-strong-seed-pw',
      MANAGER_SEED_TENANT_ID: TENANT,
      MANAGER_SEED_ROLE: 'admin',
      MANAGER_SEED_FORCE: 'true',
      MANAGER_SEED_DISPLAY_NAME: 'Dana W.',
    });
    expect(cfg).toMatchObject({ role: 'admin', force: true, displayName: 'Dana W.' });
  });

  it('does not treat the password as trimmed (a password may legitimately have edge whitespace)', () => {
    const cfg = parseSeedConfig({ MANAGER_SEED_LOGIN: 'dana', MANAGER_SEED_PASSWORD: ' spaced-pw ', MANAGER_SEED_TENANT_ID: TENANT });
    expect(cfg?.password).toBe(' spaced-pw ');
  });
});
