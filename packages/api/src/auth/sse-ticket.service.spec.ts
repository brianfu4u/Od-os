import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SseTicketService } from './sse-ticket.service';
import type { SessionIdentity } from './session.types';

const IDENTITY: SessionIdentity = { subject: 'manager', tenantId: '11111111-1111-1111-1111-111111111111', role: 'manager' };

/**
 * P0-2 sub-issue 3 (test (e)): the SSE ticket is short-lived + single-use. These pin the four
 * outcomes the guard relies on: a fresh ticket redeems exactly once; a reused ticket, an expired
 * ticket, and an unknown/empty ticket all resolve to null (→ the guard 401s).
 */
describe('SseTicketService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('issues an opaque high-entropy ticket bound to the identity', () => {
    const svc = new SseTicketService();
    const t = svc.issue(IDENTITY);
    expect(t).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
  });

  it('redeems a fresh ticket EXACTLY once (single-use: burned on read)', () => {
    const svc = new SseTicketService();
    const t = svc.issue(IDENTITY);
    expect(svc.consume(t)).toEqual(IDENTITY); // first redemption succeeds
    expect(svc.consume(t)).toBeNull(); // reuse fails
  });

  it('rejects an unknown or empty ticket', () => {
    const svc = new SseTicketService();
    expect(svc.consume('never-issued')).toBeNull();
    expect(svc.consume('')).toBeNull();
    // @ts-expect-error defensive: non-string input still returns null, never throws
    expect(svc.consume(undefined)).toBeNull();
  });

  it('rejects a ticket after it expires (~60s TTL)', () => {
    const svc = new SseTicketService();
    const t = svc.issue(IDENTITY);
    vi.advanceTimersByTime(60_000 + 1);
    expect(svc.consume(t)).toBeNull();
  });

  it('issues distinct tickets each call', () => {
    const svc = new SseTicketService();
    expect(svc.issue(IDENTITY)).not.toBe(svc.issue(IDENTITY));
  });
});
