/**
 * Freshness / activity-layer contract (T-03, feat/business-flow-p0).
 *
 * An employee's work STATUS and their ACTIVITY FRESHNESS are two separate layers. Freshness is
 * "how long since the last VALID event" and is derived read-time from the events ledger. This module
 * mirrors, in TypeScript, the single authoritative whitelist defined in 0016_freshness.sql
 * (freshness_valid_event_types()). Keep the two in sync.
 */

/**
 * VALID EVENT WHITELIST — only these event_types refresh freshness (last_event_at).
 * SSE heartbeats, page-open/polling reads, unsubmitted attachment uploads, and pure system
 * broadcasts are deliberately absent and therefore do NOT refresh freshness.
 */
export const FRESHNESS_VALID_EVENT_TYPES = [
  'employee.status.claimed',
  'patient.scanned',
  'task.flow.closed',
  'task.flow.rejected',
  'task.flow.shelved',
  'patient.flow.advanced', // reserved; emitted by a future patient-flow ticket
] as const;
export type FreshnessValidEventType = (typeof FRESHNESS_VALID_EVENT_TYPES)[number];

/** Does this event_type refresh freshness? */
export function isFreshnessEvent(eventType: string): eventType is FreshnessValidEventType {
  return (FRESHNESS_VALID_EVENT_TYPES as readonly string[]).includes(eventType);
}

/**
 * Read model of one employee's freshness. `lastEventAt` is null when the employee has no valid
 * event yet. `secondsSinceLastEvent` is null in that case too; consumers treat null as "stale".
 */
export interface EmployeeFreshness {
  employeeId: string;
  claimedStatus: string | null;
  lastEventAt: string | null;
  secondsSinceLastEvent: number | null;
}
