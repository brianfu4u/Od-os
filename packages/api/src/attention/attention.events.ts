/**
 * Centralized event-kind constants for the attention layer.
 *
 * These sit alongside `employee.status.claimed` / `patient.scanned` (stage 2) and `task.flow.*`
 * (#34) in the SAME append-only events ledger — no parallel audit table.
 *
 * P1-5 REMOVED `attention.candidate.generated`: the T-10 design wrote that event for every candidate
 * on each read of GET /attention/queue. It was deleted (intentional design change, not a bug fix)
 * because nothing downstream consumed it (write-only) and a GET must never mutate — the attention
 * queue is read-only. Any future candidate-generation audit belongs on a real write operation
 * (claim / verify / scan), not on the read path.
 *
 * `attention.item.viewed` is a P1 mount point (a manager opening an item). It is declared here for
 * naming discipline but is NOT emitted in this P0 round.
 */

/** P1 mount point — declared, not emitted in P0. */
export const ATTENTION_EVENT_ITEM_VIEWED = 'attention.item.viewed' as const;
