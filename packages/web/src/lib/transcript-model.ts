/**
 * Pure derivation of the voice-transcript UI from the scoped backend feed. Side-effect-free so it is
 * unit-testable in node (matches domain-model.ts) and the React components stay dumb.
 *
 * ⛔ MOAT (UI side): a transcript and its STT confidence are NEVER a verdict. This model keeps three
 * things strictly separate:
 *   - transcript  → what STT heard (text + STT confidence). Fed to LLM1.
 *   - claim       → what LLM1 asserted (claimed_state). A CLAIM, not a verdict.
 *   - verdict     → the Task's verified_state + verification confidence, owned solely by the
 *                   deterministic cross-verification engine (S2). This is the ONLY "verified" source.
 * There is deliberately no path here that turns a transcript/STT confidence into a verified verdict.
 * Everything traces to a real backend field — nothing is fabricated (synthetic demo items are flagged).
 */
import type { VoiceFeedRecord } from '@clearview/shared';

export type TranscriptStatus = 'done' | 'low_confidence' | 'failed' | 'unavailable' | 'none';

/** Shape of `Document.properties.transcript` written by the backend (P7/T4). */
export interface TranscriptData {
  text?: string | null;
  status?: string | null;
  language?: string | null;
  confidence?: number | null;
  provider?: string | null;
  model?: string | null;
  error?: string | null;
  at?: string | null;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const TONE: Record<TranscriptStatus, Tone> = {
  done: 'ok',
  low_confidence: 'warn',
  failed: 'bad',
  unavailable: 'muted',
  none: 'muted',
};

const KNOWN: TranscriptStatus[] = ['done', 'low_confidence', 'failed', 'unavailable'];

function normalizeStatus(s: unknown): TranscriptStatus {
  return typeof s === 'string' && (KNOWN as string[]).includes(s) ? (s as TranscriptStatus) : 'none';
}

export interface TranscriptView {
  status: TranscriptStatus;
  /** i18n key: transcript.status.<status> */
  statusKey: string;
  /** Semantic tone for the status badge; the component maps it to colors. */
  tone: Tone;
  /** Whether to render transcript text at all. */
  showText: boolean;
  /** The transcript text to render AS PLAIN TEXT (null unless done/low_confidence with text). */
  text: string | null;
  /** low_confidence → show a "not adopted as a claim" note. */
  notApplied: boolean;
  /** failed/unavailable → offer a retry entry. */
  retryable: boolean;
  provider: string | null;
  model: string | null;
  language: string | null;
  /** STT confidence in [0,1] — NOT a verification confidence. */
  sttConfidence: number | null;
  /** Provider error summary for failed (backend messages only; never secrets). */
  errorText: string | null;
  at: string | null;
}

/**
 * Derive the view for one transcript. `raw` missing/undefined (e.g. an older Document, or a voice
 * clip still being transcribed) degrades gracefully to status 'none' — no throw, no blank screen.
 */
export function transcriptView(raw: TranscriptData | null | undefined): TranscriptView {
  const status = normalizeStatus(raw?.status);
  const canHaveText = status === 'done' || status === 'low_confidence';
  const rawText = canHaveText && typeof raw?.text === 'string' ? raw.text : null;
  const text = rawText && rawText.length > 0 ? rawText : null;
  return {
    status,
    statusKey: `transcript.status.${status}`,
    tone: TONE[status],
    showText: text != null,
    text,
    notApplied: status === 'low_confidence',
    retryable: status === 'failed' || status === 'unavailable',
    provider: raw?.provider ?? null,
    model: raw?.model ?? null,
    language: raw?.language ?? null,
    sttConfidence: typeof raw?.confidence === 'number' ? raw.confidence : null,
    errorText: status === 'failed' ? (raw?.error ?? null) : null,
    at: raw?.at ?? null,
  };
}

export interface ClaimView {
  taskType: string | null;
  claimedState: string;
}

export interface VerdictView {
  /** verified | conflict | pending | unverified (from the Task; the only "verified" source). */
  verifiedState: string;
  /** Verification confidence in [0,1] — distinct from STT confidence. */
  confidence: number | null;
}

export interface TranscriptFeedItem {
  /** The voice Document id (used as the retry target). */
  id: string;
  at: string | null;
  /** True only for env-gated demo items — the UI must badge these as synthetic. */
  synthetic: boolean;
  transcript: TranscriptView;
  /** What LLM1 heard (a CLAIM), or null when the transcript produced none. */
  claim: ClaimView | null;
  /** The cross-verification verdict of the Task this claim drove, or null when none/not yet. */
  verdict: VerdictView | null;
}

/**
 * Derive the CLAIM from a voice Document's `properties.llm`. LLM1 writes both `llm.claim` (with the
 * claimed_state) and `llm.classification` — the taskType is reliably on the classification, so we
 * prefer `claim.taskType` and fall back to `classification.taskType` (else omit gracefully).
 */
function claimFrom(properties: Record<string, unknown>): ClaimView | null {
  const llm = properties.llm && typeof properties.llm === 'object' ? (properties.llm as Record<string, unknown>) : null;
  if (!llm) return null;
  const claim = llm.claim && typeof llm.claim === 'object' ? (llm.claim as Record<string, unknown>) : null;
  const claimedState = typeof claim?.claimedState === 'string' && claim.claimedState ? claim.claimedState : null;
  if (!claimedState) return null;
  const classification =
    llm.classification && typeof llm.classification === 'object' ? (llm.classification as Record<string, unknown>) : null;
  const taskType =
    (typeof claim?.taskType === 'string' && claim.taskType) ||
    (typeof classification?.taskType === 'string' && classification.taskType) ||
    null;
  return { taskType, claimedState };
}

/**
 * Build the transcript feed from the scoped backend records (GET /transcription/feed). The backend
 * already restricts to the tenant's voice evidence and joins each transcript's Task verdict, so the
 * client no longer pulls/filters full object lists. Synthetic demo items are appended ONLY when
 * `synthetic` is true (env-gated, off in production) and are flagged so the UI can badge them.
 */
export function buildFeed(
  records: VoiceFeedRecord[],
  opts: { synthetic?: boolean; syntheticItems?: TranscriptFeedItem[] } = {},
): TranscriptFeedItem[] {
  const items: TranscriptFeedItem[] = records.map((r) => {
    const properties = r.properties && typeof r.properties === 'object' ? r.properties : {};
    const view = transcriptView(properties.transcript as TranscriptData | undefined);
    return {
      id: r.objectId,
      at: r.at ?? view.at ?? null,
      synthetic: false,
      transcript: view,
      claim: claimFrom(properties),
      verdict: r.verdict ?? null,
    };
  });

  if (opts.synthetic && opts.syntheticItems && opts.syntheticItems.length > 0) {
    items.push(...opts.syntheticItems);
  }

  return items.sort((a, b) => tsOf(b.at) - tsOf(a.at));
}

function tsOf(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}
