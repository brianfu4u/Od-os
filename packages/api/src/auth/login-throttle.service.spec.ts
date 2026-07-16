import { describe, expect, it } from 'vitest';
import { HttpException } from '@nestjs/common';
import { LoginThrottleService } from './login-throttle.service';

const KEY = 'dana|203.0.113.7';

/**
 * P0-2 sub-issue 4b (test (g)): N consecutive failures within the window lock the key; while locked,
 * EVERY attempt — even a correct password — is refused with 429 until the lockout window clears. A
 * successful login before the threshold clears the counter.
 */
describe('LoginThrottleService', () => {
  it('does not lock before the threshold, and a success resets the counter', () => {
    const svc = new LoginThrottleService();
    for (let i = 0; i < 4; i += 1) svc.recordFailure(KEY); // 4 < 5
    expect(() => svc.assertNotLocked(KEY)).not.toThrow();
    svc.recordSuccess(KEY); // clears the 4 failures
    for (let i = 0; i < 4; i += 1) svc.recordFailure(KEY); // 4 again, still under threshold
    expect(() => svc.assertNotLocked(KEY)).not.toThrow();
  });

  it('locks after 5 failures and 429s further attempts (even correct-password ones)', () => {
    const svc = new LoginThrottleService();
    for (let i = 0; i < 5; i += 1) svc.recordFailure(KEY);
    let thrown: unknown;
    try {
      svc.assertNotLocked(KEY);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(429);
    const body = (thrown as HttpException).getResponse() as { retryAfterSeconds?: number };
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('clears the lockout once the window elapses', () => {
    const svc = new LoginThrottleService();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i += 1) svc.recordFailure(KEY, t0);
    expect(() => svc.assertNotLocked(KEY, t0 + 1000)).toThrow(); // still locked
    expect(() => svc.assertNotLocked(KEY, t0 + 15 * 60 * 1000 + 1)).not.toThrow(); // window passed
  });

  it('scopes lockout per key (one account/IP does not lock another)', () => {
    const svc = new LoginThrottleService();
    for (let i = 0; i < 5; i += 1) svc.recordFailure('a|ip1');
    expect(() => svc.assertNotLocked('a|ip1')).toThrow();
    expect(() => svc.assertNotLocked('b|ip2')).not.toThrow();
  });
});
