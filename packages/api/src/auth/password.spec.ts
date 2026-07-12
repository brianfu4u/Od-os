import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, applyPepper, DUMMY_PASSWORD_HASH } from './password';

describe('password hashing (scrypt, zero-dependency)', () => {
  it('round-trips a correct password and emits the self-describing scrypt encoding', () => {
    const h = hashPassword('correct horse battery staple');
    expect(h.startsWith('scrypt$16384$8$1$')).toBe(true);
    expect(h.split('$')).toHaveLength(6);
    expect(verifyPassword('correct horse battery staple', h)).toBe(true);
  });

  it('rejects a wrong or empty password', () => {
    const h = hashPassword('s3cret-passphrase');
    expect(verifyPassword('S3cret-passphrase', h)).toBe(false); // case-sensitive
    expect(verifyPassword('s3cret-passphras', h)).toBe(false); // off by one
    expect(verifyPassword('', h)).toBe(false);
  });

  it('uses a fresh random salt each call (same password ⇒ different encodings, both verify)', () => {
    const a = hashPassword('same-password-123');
    const b = hashPassword('same-password-123');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password-123', a)).toBe(true);
    expect(verifyPassword('same-password-123', b)).toBe(true);
  });

  it('returns false for malformed encodings and never throws', () => {
    const bad = [
      '',
      'not-a-hash',
      'scrypt$only$three',
      'bcrypt$16384$8$1$YWE=$YmI=', // wrong scheme
      'scrypt$x$y$z$YWE=$YmI=', // non-numeric params
      'scrypt$16384$8$1$$', // empty salt/hash
    ];
    for (const b of bad) expect(verifyPassword('x', b)).toBe(false);
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', undefined)).toBe(false);
  });

  it('optional pepper changes the derived hash and gates verification (defense-in-depth)', () => {
    const withPepper = { AUTH_PASSWORD_PEPPER: 'a-long-server-side-pepper-value' };
    const noPepper = {};
    expect(applyPepper('pw', withPepper)).not.toBe('pw');
    expect(applyPepper('pw', noPepper)).toBe('pw');

    const h = hashPassword('pw-123', withPepper);
    expect(verifyPassword('pw-123', h, withPepper)).toBe(true); // correct pepper
    expect(verifyPassword('pw-123', h, noPepper)).toBe(false); // DB leak without the pepper is useless
  });

  it('exposes a well-formed dummy hash for constant-time unknown-login handling', () => {
    expect(DUMMY_PASSWORD_HASH.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('anything', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});
