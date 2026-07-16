import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { SessionIdentity } from './session.types';

/**
 * P0-2 sub-issue 3: short-lived, SINGLE-USE tickets for EventSource/SSE.
 *
 * The browser's EventSource API cannot set an Authorization header, so the old code put the raw
 * session token in the URL query string (`/objects/stream?session=<token>`). URLs leak into server
 * access logs, proxy logs, browser history and Referer headers — so that exposed a long-lived bearer
 * credential. Instead, an already-authenticated caller (cookie/bearer) POSTs /auth/sse-ticket to mint
 * an opaque ticket that is valid for ~60s and can be redeemed EXACTLY ONCE. The SSE endpoint accepts
 * `?ticket=<t>`; the guard consumes it (delete-on-read) and resolves the caller's identity. A leaked
 * ticket is near-worthless: it expires in seconds and is burned on first use.
 *
 * In-memory by design: tickets are ephemeral and single-process here. If the API is ever scaled to
 * multiple instances, back this with the shared cache/Redis so a ticket minted on one instance can be
 * redeemed on another (documented as a follow-up, not needed for the current single-instance deploy).
 */
const TICKET_TTL_MS = 60 * 1000;

interface TicketEntry {
  identity: SessionIdentity;
  expiresAt: number;
}

@Injectable()
export class SseTicketService {
  private readonly tickets = new Map<string, TicketEntry>();

  /** Mint a single-use ticket bound to the caller's already-authenticated identity. */
  issue(identity: SessionIdentity): string {
    this.prune();
    const ticket = randomBytes(32).toString('hex');
    this.tickets.set(ticket, { identity, expiresAt: Date.now() + TICKET_TTL_MS });
    return ticket;
  }

  /**
   * Redeem a ticket EXACTLY ONCE. Returns the bound identity if the ticket exists, is unexpired, and
   * has not been used; otherwise null. The ticket is deleted on read, so a second redemption fails.
   */
  consume(ticket: string): SessionIdentity | null {
    if (typeof ticket !== 'string' || ticket.length === 0) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket); // single-use: burn on read, even if expired
    if (Date.now() > entry.expiresAt) return null;
    return entry.identity;
  }

  private prune(): void {
    const now = Date.now();
    for (const [t, e] of this.tickets) {
      if (now > e.expiresAt) this.tickets.delete(t);
    }
  }
}
