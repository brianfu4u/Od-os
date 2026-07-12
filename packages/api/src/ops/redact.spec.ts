import { describe, it, expect } from 'vitest';
import { redact, scrubString, safeError, isSensitiveKey, REDACTED } from './redact';

describe('isSensitiveKey', () => {
  it('flags credential-ish keys and leaves benign ones', () => {
    for (const k of ['password', 'passwd', 'pwd', 'token', 'authorization', 'cookie', 'apiKey', 'api_key', 'STT_API_KEY', 'secret', 'pepper', 'credential', 'cv_session'])
      expect(isSensitiveKey(k)).toBe(true);
    for (const k of ['tenantId', 'status', 'route', 'count', 'requestId', 'ms']) expect(isSensitiveKey(k)).toBe(false);
  });
});

describe('redact', () => {
  it('replaces sensitive values, preserves benign ones, recurses', () => {
    const out = redact({
      password: 'hunter2',
      apiKey: 'sk-abc',
      nested: { authorization: 'Bearer abc.def', keep: 42 },
      note: 'hello',
    }) as Record<string, any>;
    expect(out.password).toBe(REDACTED);
    expect(out.apiKey).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.nested.keep).toBe(42);
    expect(out.note).toBe('hello');
  });

  it('bounds depth and array length and never throws', () => {
    const deep: any = { a: { b: { c: { d: { e: 'too deep' } } } } };
    expect(() => redact(deep)).not.toThrow();
    const big = { arr: Array.from({ length: 100 }, (_, i) => i) };
    expect((redact(big) as any).arr.length).toBeLessThanOrEqual(20);
  });
});

describe('scrubString', () => {
  it('scrubs bearer tokens, session values, and long opaque blobs', () => {
    expect(scrubString('Authorization: Bearer abcDEF123.ghi_jkl-456')).not.toContain('abcDEF123');
    expect(scrubString('cv_session=deadbeefcafe12345')).toContain('[REDACTED]');
    expect(scrubString(`x ${'a'.repeat(40)}`)).toContain('[REDACTED]');
  });
});

describe('safeError', () => {
  it('carries status, keeps name, scrubs the message', () => {
    const e = safeError(Object.assign(new Error('token=supersecretvalue123456 boom'), { status: 401 }));
    expect(e.status).toBe(401);
    expect(e.name).toBe('Error');
    expect(e.message).not.toContain('supersecretvalue123456');
  });
  it('handles non-Error throwables', () => {
    expect(safeError('plain string').name).toBe('NonError');
  });
});
