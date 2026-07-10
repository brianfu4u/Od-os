/**
 * Versioned, auditable prompts for the DeepSeek adapter. The version string is written to the
 * append-only llm_analysis_log on every run, so any analysis can be traced back to the exact prompt
 * that produced it. Bump the version (e.g. v1 → v2) whenever the wording or output contract changes.
 *
 * The prompts pin a STRICT JSON output contract and — critically — instruct the model that it may
 * only ever report a CLAIM, never a verification verdict. The moat is also enforced structurally by
 * the normalizer (deepseek-listener), so a misbehaving model cannot break it; the prompt just makes
 * the intended behavior explicit and cheap.
 */
import type { ListenInput, SummaryInput } from './listener.types';

export const PROMPT_VERSIONS = {
  analyze: 'listen.analyze/v1',
  summarize: 'listen.summarize/v1',
} as const;

const ANALYZE_SYSTEM = `You are LLM1, the "Listen" layer of Clearview OD, a real-time operating system for optometry clinics.
You receive ONE staff report/event from a clinic terminal and return a STRICT JSON object. Reply in the SAME language as the report (Chinese, Japanese, or English) for human-readable fields; use the fixed enums verbatim for coded fields.

Do FOUR things:
1) ANALYZE — what happened, and what state the staff CLAIMS for which task/room. Extract the claim only; do NOT judge whether it is true.
2) CLASSIFY — domain, S0-7 task type, event type, severity.
3) SUGGEST — up to 3 candidate manager cues (advisory).
4) SUMMARIZE — one short human sentence in "summary".

HARD RULE: You only ever report a CLAIM (what the staff says they did). You NEVER decide "verified". Verification is done by a separate deterministic engine. If unsure or ambiguous, lower "confidence" and set "claim" to null.

Output JSON schema (no prose, no markdown):
{
  "summary": string,
  "claim": null | { "taskType": one of ["room_turnover","pretest_done","dilation_started","inventory_reorder","equipment_calibration"] or null,
                     "claimedState": string, "locator": { "room"?: string, "label"?: string } },
  "classification": { "domain": one of ["patient_flow","staff","inventory","equipment","financial","marketing","general"],
                      "taskType": string or null,
                      "eventType": one of ["clock_in","clock_out","task_update","report","evidence","scan","support_request","anomaly","other"],
                      "severity": one of ["info","low","medium","high"] },
  "candidateCues": [ { "domain": <domain>, "title": string, "detail"?: string, "severity": <severity> } ],
  "confidence": number between 0 and 1
}`;

const SUMMARIZE_SYSTEM = `You are LLM1, the "Listen" layer of Clearview OD. Summarize a window of clinic terminal events for a manager.
Write a concise, factual summary (2-4 sentences) in the requested language. Note volume, notable events (conflicts, support requests, anomalies), and per-domain highlights. Do NOT invent data or verify claims. Return STRICT JSON: { "text": string }.`;

export function buildAnalyzeMessages(input: ListenInput): { system: string; user: string } {
  const user = JSON.stringify({
    text: input.text ?? '',
    reportType: input.reportType ?? null,
    fields: input.fields ?? {},
    hasAttachments: !!input.hasAttachments,
    hasScans: !!input.hasScans,
    locale: input.locale ?? null,
  });
  return { system: ANALYZE_SYSTEM, user };
}

export function buildSummarizeMessages(input: SummaryInput): { system: string; user: string } {
  const user = JSON.stringify({
    scope: input.scope,
    locale: input.locale,
    periodHours: input.periodHours,
    events: input.events.slice(0, 200),
  });
  return { system: SUMMARIZE_SYSTEM, user };
}
