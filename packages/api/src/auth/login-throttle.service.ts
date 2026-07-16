import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * P0-2 sub-issue 4b: a minimal in-memory failed-login limiter with lockout.
 *
 * There is no @nestjs/throttler dependency (and CI forbids lockfile changes), so this is a small
 * zero-dependency sliding-window limiter scoped to a login+IP key. After MAX_FAILURES failed attempts
 * inside WINDOW_MS, the key is LOCKED for LOCKOUT_MS: every further attempt — even with the correct
 * password — is rejected with 429 until the lockout expires. A successful login clears the key.
 *
 * In-memory + single-process, matching this deploy. If scaled horizontally, back it with the shared
 * cache/Redis (documented follow-up). It intentionally protects the credential login endpoint only;
 * session-token auth is not rate-limited here (tokens are high-entropy and unguessable).
 */
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 min rolling window for counting failures
const LOCKOUT_MS = 15 * 60 * 1000; // 15 min lockout once the threshold is crossed

interface Attempts {
  failures: number[]; // timestamps of recent failures (within the window)
  lockedUntil: number; // 0 = not locked
}

@Injectable()
export class LoginThrottleService {
  private readonly byKey = new Map<string, Attempts>();

  /** Throw 429 if the key is currently locked out. Call BEFORE verifying the password. */
  assertNotLocked(key: string, now: number = Date.now()): void {
    const a = this.byKey.get(key);
    if (a && a.lockedUntil > now) {
      const retryAfter = Math.ceil((a.lockedUntil - now) / 1000);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many failed login attempts. Try again later.',
          retryAfterSeconds: retryAfter,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Record a failed attempt; trips the lockout once MAX_FAILURES is reached within the window. */
  recordFailure(key: string, now: number = Date.now()): void {
    const a = this.byKey.get(key) ?? { failures: [], lockedUntil: 0 };
    a.failures = a.failures.filter((t) => now - t < WINDOW_MS);
    a.failures.push(now);
    if (a.failures.length >= MAX_FAILURES) {
      a.lockedUntil = now + LOCKOUT_MS;
      a.failures = [];
    }
    this.byKey.set(key, a);
  }

  /** Clear all state for a key after a successful login. */
  recordSuccess(key: string): void {
    this.byKey.delete(key);
  }
}
