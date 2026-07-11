import { describe, expect, it } from 'vitest';
import {
  assertProductionSecurity,
  isValidOrigin,
  parseCorsAllowList,
  resolveCorsOptions,
  resolveDbSsl,
} from './security';

const HOSTED = 'postgresql://u:p@db.example.com:5432/clearview_od';
const LOCAL = 'postgresql://postgres:postgres@localhost:5432/clearview_od';
const PEM = '-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----';

const prod = (over: Record<string, string | undefined> = {}) => ({ NODE_ENV: 'production', ...over });

describe('resolveDbSsl — production always verifies (verify-full), never rejectUnauthorized:false', () => {
  it('production + CA → { rejectUnauthorized: true, ca }', () => {
    expect(resolveDbSsl(HOSTED, prod({ DATABASE_CA_CERT: PEM }))).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  it('production without CA still verifies (CA presence is guarded separately at boot)', () => {
    expect(resolveDbSsl(HOSTED, prod())).toEqual({ rejectUnauthorized: true });
  });

  it('production NEVER downgrades — even with DATABASE_SSL=false it stays verifying', () => {
    const ssl = resolveDbSsl(HOSTED, prod({ DATABASE_SSL: 'false', DATABASE_CA_CERT: PEM }));
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(ssl).not.toEqual(expect.objectContaining({ rejectUnauthorized: false }));
  });

  it('dev localhost → off (undefined)', () => {
    expect(resolveDbSsl(LOCAL, { NODE_ENV: 'development' })).toBeUndefined();
  });

  it('dev hosted (no CA) → accepts managed cert (rejectUnauthorized:false) for synthetic staging', () => {
    expect(resolveDbSsl(HOSTED, { NODE_ENV: 'development' })).toEqual({ rejectUnauthorized: false });
  });

  it('dev DATABASE_SSL=false → off; dev + CA → verifies', () => {
    expect(resolveDbSsl(HOSTED, { NODE_ENV: 'development', DATABASE_SSL: 'false' })).toBeUndefined();
    expect(resolveDbSsl(HOSTED, { NODE_ENV: 'development', DATABASE_CA_CERT: PEM })).toEqual({ rejectUnauthorized: true, ca: PEM });
  });
});

describe('resolveCorsOptions — explicit allow-list, never a wildcard', () => {
  it('allow-list set → restricts to it, credentials on, no "*"', () => {
    const o = resolveCorsOptions(prod({ CORS_ORIGIN: 'https://a.example.com, https://b.example.com' }));
    expect(o.origin).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(o.credentials).toBe(true);
    expect(o.methods).toContain('OPTIONS');
    expect(Array.isArray(o.origin) && o.origin.includes('*')).toBe(false);
  });

  it('accepts the CORS_ALLOWED_ORIGINS alias', () => {
    expect(resolveCorsOptions(prod({ CORS_ALLOWED_ORIGINS: 'https://a.example.com' })).origin).toEqual(['https://a.example.com']);
  });

  it('dev empty → reflect request origin (true); production empty → deny all (false)', () => {
    expect(resolveCorsOptions({ NODE_ENV: 'development' }).origin).toBe(true);
    expect(resolveCorsOptions(prod()).origin).toBe(false);
  });
});

describe('assertProductionSecurity — fail-closed boot guard', () => {
  const OK = prod({ DATABASE_CA_CERT: PEM, CORS_ORIGIN: 'https://app.example.com' });

  it('no-op outside production (dev with nothing configured does not throw)', () => {
    expect(() => assertProductionSecurity({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('passes when production is fully configured', () => {
    expect(() => assertProductionSecurity(OK)).not.toThrow();
  });

  it('PASSES in production without a CA — TLS still verifies against public CAs (CA is an optional override)', () => {
    expect(() => assertProductionSecurity(prod({ CORS_ORIGIN: 'https://app.example.com' }))).not.toThrow();
  });

  it('throws when TLS is explicitly disabled in production', () => {
    expect(() => assertProductionSecurity({ ...OK, DATABASE_SSL: 'false' })).toThrow(/DATABASE_SSL/);
  });

  it('throws when the CORS allow-list is empty', () => {
    expect(() => assertProductionSecurity(prod({ DATABASE_CA_CERT: PEM }))).toThrow(/CORS/);
  });

  it('throws when the CORS allow-list contains a wildcard', () => {
    expect(() => assertProductionSecurity(prod({ DATABASE_CA_CERT: PEM, CORS_ORIGIN: '*' }))).toThrow(/"\*"/);
  });

  it('throws when a CORS entry is not a bare origin', () => {
    expect(() => assertProductionSecurity(prod({ DATABASE_CA_CERT: PEM, CORS_ORIGIN: 'https://app.example.com/app' }))).toThrow(/valid origin/);
  });
});

describe('helpers', () => {
  it('parseCorsAllowList trims + drops empties; alias precedence', () => {
    expect(parseCorsAllowList({ CORS_ORIGIN: ' https://a.com , , https://b.com ' })).toEqual(['https://a.com', 'https://b.com']);
    expect(parseCorsAllowList({ CORS_ORIGIN: 'https://old.com', CORS_ALLOWED_ORIGINS: 'https://new.com' })).toEqual(['https://new.com']);
  });

  it('isValidOrigin accepts bare origins, rejects paths / wildcards / junk', () => {
    expect(isValidOrigin('https://x.com')).toBe(true);
    expect(isValidOrigin('https://x.com:8080')).toBe(true);
    expect(isValidOrigin('https://x.com/')).toBe(false);
    expect(isValidOrigin('https://x.com/path')).toBe(false);
    expect(isValidOrigin('*')).toBe(false);
    expect(isValidOrigin('not-a-url')).toBe(false);
  });
});
