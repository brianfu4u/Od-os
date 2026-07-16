/**
 * Attention-queue contract (T-06 / T-07, feat/attention-p0).
 *
 * The attention queue is a manager-side, READ-ONLY "list of things worth a look" derived at read
 * time from the facts already collected in stage 1/2 (employee_status_claims, patient_scans, the
 * events ledger, and the employee_freshness view). It is NOT a message feed and NOT an adjudication
 * entry point:
 *   - there is NO accept / dismiss action that changes world state (that is `decide`, physically
 *     isolated in the assignments module);
 *   - generating or reading the queue NEVER produces an employee-visible event and NEVER mutates
 *     claimed_status / flow_state;
 *   - a candidate that no longer holds simply stops being generated on the next read (auto-dequeue).
 *
 * Naming discipline: this layer speaks `candidate` (a rule's raw finding) / `item` (a deduped,
 * manager-facing row) / `kind` (which rule fired). It deliberately does NOT reuse the
 * `claim` vs `verified` vocabulary of the status layer.
 */

/** Which rule produced the finding. Four P0 generators (T-07). */
export const ATTENTION_KINDS = [
  'silence', // on_duty but no valid event for longer than the silence threshold
  'status_inconsistency', // claims busy but no corroborating activity in the window
  'scan_no_followup', // a scan happened but no patient-flow progress within the window
  'low_confidence', // the silent consistency check verdict is inconsistent / below the threshold
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export function isAttentionKind(v: unknown): v is AttentionKind {
  return typeof v === 'string' && (ATTENTION_KINDS as readonly string[]).includes(v);
}

/**
 * A compact, neutral "here are the facts" summary attached to every item. Every field is a plain
 * observed fact — never a verdict, an instruction, or a score shown to the employee.
 */
export interface AttentionEvidenceSummary {
  /** The employee this item concerns (display name, manager-facing). */
  who: string;
  /** When the triggering fact was last observed (ISO), or null if never. */
  when: string | null;
  /** What the employee CLAIMED (their self-declared status), or null. */
  claimed: string | null;
  /**
   * What the employee SUBMITTED (their most recent volunteered fact, e.g. a scan code).
   *
   * P1-6-f privacy change: this is NEVER the raw value on the wire. When the underlying fact is a
   * raw patient scan code it is returned MASKED (e.g. `PT-****`); the full value is obtained only
   * via the audited manager-only `POST /attention/reveal-scan-code`. When there is no such fact it
   * is null. Non-sensitive `submitted` facts (currently none) would pass through unmasked.
   */
  submitted: string | null;
  /**
   * True when `submitted` is a MASKED sensitive value that a manager may reveal in full via the
   * audited reveal endpoint. False/absent when `submitted` is null or a non-sensitive plain fact.
   */
  revealable?: boolean;
  /** What the system OBSERVED (a derived, read-time fact, e.g. "3720s since last valid event"). */
  systemObserved: string | null;
}

/**
 * A raw finding from a single rule, BEFORE the display-layer dedup/cooldown of the queue service.
 * The audit layer (T-10) records EVERY candidate (no dedup at the write layer). Dedup happens only
 * in the queue's presentation query (T-06), never at the event-write layer.
 */
export interface AttentionCandidate {
  employeeId: string;
  employeeName: string;
  kind: AttentionKind;
  evidenceSummary: AttentionEvidenceSummary;
  /** When the triggering fact was last observed (ISO), or null. Mirrors evidenceSummary.when. */
  lastEventAt: string | null;
  /** When this candidate was generated (read time, ISO). */
  generatedAt: string;
}

/**
 * A manager-facing queue row: a candidate after display-layer dedup (same employee + same kind
 * collapses to one). `id` is a deterministic, stateless handle (`<employeeId>:<kind>`) so the same
 * finding keeps a stable identity across reads without any stored queue table.
 */
export interface AttentionItem {
  id: string;
  employeeId: string;
  employeeName: string;
  kind: AttentionKind;
  evidenceSummary: AttentionEvidenceSummary;
  lastEventAt: string | null;
  generatedAt: string;
}

/** GET /attention/queue response. Read-only; no cursor/actions in P0. */
export interface AttentionQueueView {
  items: AttentionItem[];
}

/** Stable, stateless item id from (employee, kind). */
export function attentionItemId(employeeId: string, kind: AttentionKind): string {
  return `${employeeId}:${kind}`;
}

/**
 * P1-6-f · mask a raw patient scan code for the default (un-revealed) queue view.
 *
 * Keeps a readable prefix (through the first `-`, or the first 2 chars when there is no `-`) so a
 * manager can recognize "same patient code" at a glance, and replaces the rest with `****`. The full
 * value is NEVER placed on the wire by the queue — it is obtained only via the audited reveal
 * endpoint. Returns null for null/empty input.
 */
export function maskScanCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const dash = raw.indexOf('-');
  const prefix = dash > 0 ? raw.slice(0, dash + 1) : raw.slice(0, 2);
  return `${prefix}****`;
}

/**
 * P1-6-f · audited reveal of a masked patient scan code.
 *
 * `POST /attention/reveal-scan-code` is MANAGER-ONLY. Unlike `GET /attention/queue` (a pure read
 * that must never mutate), this is a real WRITE operation: it appends one `sensitive.raw.accessed`
 * access event to the ledger (proving WHO viewed the raw value and WHEN — the event payload NEVER
 * copies the raw content itself) and returns the full scan code. The employee it concerns is
 * identified by `staffId` (an item's `employeeId`), matching the per-employee shape of the queue.
 */
export interface RevealScanCodeRequest {
  /** The employee whose most-recent scan code to reveal — an AttentionItem.employeeId. */
  staffId: string;
}

/** Why a reveal returned no code (200 + reason rather than 404, to avoid leaking record existence). */
export type RevealScanCodeReason = 'absent' | 'redacted';

export interface RevealScanCodeResponse {
  staffId: string;
  /** The full raw scan code, or null when unavailable (see `reason`). */
  scanCode: string | null;
  /** When that scan happened (ISO), or null. */
  scanAt: string | null;
  /** Present only when `scanCode` is null: `absent` (no scan on record) or `redacted` (past retention window). */
  reason?: RevealScanCodeReason;
}
