/**
 * Centralized event-kind constants for the attention layer (T-10).
 *
 * These sit alongside `employee.status.claimed` / `patient.scanned` (stage 2) and `task.flow.*`
 * (#34) in the SAME append-only events ledger — no parallel audit table.
 *
 * `attention.candidate.generated` is written for EVERY generated candidate at read time. There is
 * deliberately NO dedup at this write layer: "only state facts, log everything" means the audit
 * layer must never drop a fact. Display-layer dedup (avoiding manager-side flooding) is the queue
 * service's job (T-06), and happens strictly after — never before — the audit write.
 *
 * `attention.item.viewed` is a P1 mount point (a manager opening an item). It is declared here for
 * naming discipline but is NOT emitted in this P0 round.
 */
export const ATTENTION_EVENT_CANDIDATE_GENERATED = 'attention.candidate.generated' as const;

/** P1 mount point — declared, not emitted in P0. */
export const ATTENTION_EVENT_ITEM_VIEWED = 'attention.item.viewed' as const;
