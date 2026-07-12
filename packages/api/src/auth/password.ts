/**
 * Password hashing for manager credentials — zero-dependency, built on Node's `crypto.scrypt`.
 *
 * WHY scrypt (not bcrypt/argon2): scrypt is a memory-hard password KDF (RFC 7914) shipped in Node's
 * standard library, so it adds NO dependency. A bcrypt/argon2 package would require updating the
 * lockfile, which the CI's `pnpm install --frozen-lockfile` forbids in this environment. scrypt with
 * these parameters is a standards-grade choice for credential hashing.
 *
 * Encoding is self-describing so parameters can evolve without a migration:
 *     scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * SECURITY NOTES
 *  - A fresh 16-byte random salt per hash (so equal passwords never share an encoding).
 *  - Verification is constant-time (`timingSafeEqual`) and never throws on malformed input.
 *  - The plaintext password is NEVER logged and NEVER stored — only the derived hash is persisted.
 *  - Optional pepper (AUTH_PASSWORD_PEPPER): when set, the password is pre-hashed with HMAC-SHA256
 *    under that env-only key before scrypt, so a database leak WITHOUT the pepper is useless. It is
 *    OPTIONAL by design (mirrors P5.1's optional DATABASE_CA_CERT): unset ⇒ the plain password goes
 *    into scrypt, so the feature works out of the box and the pepper can be introduced later.
 */
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

type Env = Record<string, string | undefined>;

const SCHEME = 'scrypt';
const N = 16384; // CPU/memory cost — 2^14 (interactive login latency, ~tens of ms)
const R = 8; // block size
const P = 1; // parallelization
const KEYLEN = 64; // derived key length (bytes)
const SALT_BYTES = 16;
const MAXMEM = 64 * 1024 * 1024; // 64 MiB — headroom over 128*N*r (~16 MiB) so scrypt never ENOMEM-throws

/**
 * Apply the optional server-side pepper. Returns the plaintext unchanged when AUTH_PASSWORD_PEPPER
 * is unset (default), or its HMAC-SHA256 (hex) under the pepper key when set.
 */
export function applyPepper(plain: string, env: Env = process.env): string {
  const pepper = env.AUTH_PASSWORD_PEPPER?.trim();
  if (!pepper) return plain;
  return createHmac('sha256', pepper).update(plain, 'utf8').digest('hex');
}

/** Hash a plaintext password into a self-describing `scrypt$N$r$p$salt$hash` string. */
export function hashPassword(plain: string, env: Env = process.env): string {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(applyPepper(plain, env), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [SCHEME, N, R, P, salt.toString('base64'), derived.toString('base64')].join('$');
}

/**
 * Verify a plaintext password against an encoded hash, in constant time.
 * Returns false for any malformed/empty input or scheme mismatch — never throws, never logs.
 */
export function verifyPassword(plain: string, encoded: string | null | undefined, env: Env = process.env): boolean {
  if (typeof plain !== 'string' || plain.length === 0) return false;
  if (typeof encoded !== 'string' || encoded.length === 0) return false;

  const parts = encoded.split('$');
  if (parts.length !== 6) return false;
  const [scheme, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (scheme !== SCHEME) return false;

  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || r < 1 || p < 1) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltB64!, 'base64');
    expected = Buffer.from(hashB64!, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(applyPepper(plain, env), salt, expected.length, { N: n, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * A fixed, well-formed hash used for a constant-time DUMMY verify when a login is unknown or has no
 * credential set — so the "no such manager" path spends ~the same time as a real verify, denying an
 * attacker a timing oracle for enumerating valid logins. Computed once at module load.
 */
export const DUMMY_PASSWORD_HASH = hashPassword('clearview-od::dummy::not-a-real-credential');
