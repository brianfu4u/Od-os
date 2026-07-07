/**
 * Append-only ledgers: the agentic-loop event stream and the verification ledger.
 * Source of truth: docs/01-structure-design.md §4 (Verification Ledger) and §5 (loop).
 *
 * Both are INSERT-ONLY in the database (enforced by triggers + revoked privileges).
 */

/** A row in the append-only `events` table. */
export interface OntologyEvent<TPayload = Record<string, unknown>> {
  id: string;
  tenantId: string;
  /** Object-scoped events reference an object; system-level events may be null. */
  objectId: string | null;
  /** e.g. 'object.created', 'object.state.claimed', 'loop.run.completed'. */
  eventType: string;
  payload: TPayload;
  /** Staff id, agent name, or 'system'. */
  actor: string | null;
  createdAt: string;
}

/**
 * A row in the append-only `verification_ledger` — the immutable record of
 * cross-verified operational truth. This is the product's moat asset:
 * the single trusted source of state, an SOP-compliance archive, and training data.
 */
export interface VerificationLedgerEntry<TEvidence = Record<string, unknown>> {
  id: string;
  tenantId: string;
  /** The object whose state was verified. */
  objectId: string;
  /** Optional link to a Verification object in `objects`. */
  verificationId: string | null;
  verifiedState: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** Structured evidence chips (communication / document / snapshot / schedule / model). */
  evidence: TEvidence;
  /** Human-readable rationale for the verified state. */
  reason: string | null;
  createdAt: string;
}
