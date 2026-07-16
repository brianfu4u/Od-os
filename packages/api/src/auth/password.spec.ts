import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, applyPepper, getDummyPasswordHash } from './password';

describe('password hashing (scrypt, zero-dependency, async)', () => {
  it('round-trips a correct password and emits the self-describing scrypt encoding', async () => {
    const h = await hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(h.split('$')).toHaveLength(6);
    expect(await verifyPassword('correct horse battery staple', h)).toBe(true);
  });

  it('rejects a wrong or empty password', async () => {
    const h = await hashPassword('s3cret-passphrase');
    expect(await verifyPassword('S3cret-passphrase', h)).toBe(false); // case-sensitive
    expect(await verifyPassword('s3cret-passphras', h)).toBe(false); // off by one
    expect(await verifyPassword('', h)).toBe(false);
  });

  it('uses a fresh random salt each call (same password ⇒ different encodings, both verify)', async () => {
    const a = await hashPassword('same-password-123');
    const b = await hashPassword('same-password-123');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password-123', a)).toBe(true);
    expect(await verifyPassword('same-password-123', b)).toBe(true);
  });

  it('returns false for malformed encodings and never throws', async () => {
    const bad = [
      '',
      'not-a-hash',
      'scrypt$only$three',
      'bcrypt$16384$8$1$YWE=$YmI=', // wrong scheme
      'scrypt$x$y$z$YWE=$YmI=', // non-numeric params
      'scrypt$16384$8$1$$', // empty salt/hash
    ];
    for (const b of bad) expect(await verifyPassword('x', b)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
  });

  it('optional pepper changes the derived hash and gates verification (defense-in-depth)', async () => {
    const withPepper = { AUTH_PASSWORD_PEPPER: 'a-long-server-side-pepper-value' };
    const noPepper = {};
    expect(applyPepper('pw', withPepper)).not.toBe('pw');
    expect(applyPepper('pw', noPepper)).toBe('pw');

    const h = await hashPassword('pw-123', withPepper);
    expect(await verifyPassword('pw-123', h, withPepper)).toBe(true); // correct pepper
    expect(await verifyPassword('pw-123', h, noPepper)).toBe(false); // DB leak without the pepper is useless
  });

  it('exposes a well-formed, memoized dummy hash for constant-time unknown-login handling', async () => {
    const dummy = await getDummyPasswordHash();
    expect(dummy.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('anything', dummy)).toBe(false);
    expect(await getDummyPasswordHash()).toBe(dummy); // memoized (same instance)
  });
});
