/**
 * LLM1 · 「听」(Listen) layer — the FIRST layer of the LLM stack. It listens to every terminal's
 * event stream and does four things over each report/event: ANALYZE (semantics + extract the
 * staff's CLAIM), CLASSIFY (domain / task type / event type / severity), SUGGEST (candidate manager
 * cues → the existing S3 orchestrator), and SUMMARIZE (per shift / domain / terminal).
 *
 * ⛔ MOAT (hard line, enforced in code + tests): LLM1 writes ONLY the CLAIM (claimed_state) plus
 * classification annotations and candidate suggestions. It NEVER writes verified_state — the
 * deterministic cross-verification engine (S2) remains the sole owner of the verdict. Low
 * confidence / ambiguity → mark pending, do NOT change state. These types have NO verified field
 * anywhere, on purpose: the boundary is expressed in the schema itself.
 *
 * The adapter is pluggable (LlmListenerPort). The first real adapter is DeepSeek (OpenAI-compatible);
 * a deterministic HeuristicListener is the keyless fallback used in dev / CI / tests. Architecture
 * leaves room for LLM2+ (verification assist / conversational copilot / learning tuning).
 */

/** DI token for the active LlmListenerPort implementation. */
export const LLM_LISTENER = 'LLM_LISTENER';

export type ListenLocale = 'zh' | 'en' | 'ja';

/** Classification domain. Superset of the 6 orchestrator DomainName values plus a `general` bucket. */
export type ListenDomain =
  | 'patient_flow'
  | 'staff'
  | 'inventory'
  | 'equipment'
  | 'financial'
  | 'marketing'
  | 'general';

/** The kind of thing this event/report IS (independent of the domain it touches). */
export type ListenEventType =
  | 'clock_in'
  | 'clock_out'
  | 'task_update'
  | 'report'
  | 'evidence'
  | 'scan'
  | 'support_request'
  | 'anomaly'
  | 'other';

export type ListenSeverity = 'info' | 'low' | 'medium' | 'high';

/**
 * A CLAIM extracted from the report — "staff asserts state X for task/object Y". This is the ONLY
 * thing LLM1 is allowed to turn into a write, and only ever onto claimed_state. There is
 * deliberately no `verifiedState` here.
 */
export interface ListenClaim {
  /** Canonical S0-7 task type if recognized, else null. */
  taskType: string | null;
  /** The state the staff CLAIMS (e.g. 'ready', 'done', 'started', 'ordered', 'calibrated'). */
  claimedState: string;
  /** How to find the subject object deterministically (room label / free label / explicit id). */
  locator: { room?: string; label?: string; objectId?: string };
}

export interface ListenClassification {
  domain: ListenDomain;
  taskType: string | null;
  eventType: ListenEventType;
  severity: ListenSeverity;
}

/** A candidate manager suggestion. Advisory only — it flows THROUGH the S3 orchestrator. */
export interface ListenCue {
  domain: ListenDomain;
  title: string;
  detail?: string;
  severity: ListenSeverity;
}

export interface ListenAnalysis {
  /** One-line, human-readable semantic summary of what happened. */
  summary: string;
  /** Extracted claim, or null when the report asserts no task state. */
  claim: ListenClaim | null;
  classification: ListenClassification;
  candidateCues: ListenCue[];
  /** LLM1's confidence in this ANALYSIS (0..1). NOT a verification confidence. */
  confidence: number;
  locale: ListenLocale;
}

export interface ListenInput {
  text: string;
  reportType?: string | null;
  fields?: Record<string, unknown>;
  hasAttachments?: boolean;
  hasScans?: boolean;
  locale?: ListenLocale;
}

export interface SummaryInputEvent {
  at: string;
  eventType: string;
  domain?: string;
  taskType?: string | null;
  text?: string;
}

export interface SummaryInput {
  /** 'shift' | 'day' | `domain:<x>` | `terminal:<staff>` */
  scope: string;
  locale: ListenLocale;
  periodHours: number;
  events: SummaryInputEvent[];
}

export interface ListenSummary {
  scope: string;
  text: string;
  locale: ListenLocale;
  periodHours: number;
  count: number;
  byEventType: Record<string, number>;
  byDomain: Record<string, number>;
}

/**
 * Pluggable listener. `analyze` turns one report into a structured analysis; `summarize` rolls up a
 * window of events. Implementations must be side-effect free (no DB / no state writes) — applying
 * the claim + audit is the SERVICE's job, so the moat stays enforced in one place.
 */
export interface LlmListenerPort {
  readonly name: string;
  analyze(input: ListenInput): Promise<ListenAnalysis>;
  summarize(input: SummaryInput): Promise<ListenSummary>;
}
