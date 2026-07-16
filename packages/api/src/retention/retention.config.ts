/**
 * Retention window for SENSITIVE RAW CONTENT (P1-6-b).
 *
 * Raw content mirrored into `sensitive_payloads` (LLM input/output, patient_code, optional_note) is
 * redacted by the retention sweep once it is older than this window. The append-only audit skeleton
 * is NEVER touched — only the redactable side-store content is nulled (see 0020 redact-only trigger).
 *
 * IMPORTANT — the default of 30 days is a PROVISIONAL product default, NOT a final legal conclusion.
 * It MUST be validated against APPI (Japan) before production. It is intentionally env-configurable
 * (never hardcoded) so the window can change without a redeploy, and it is a single GLOBAL value
 * (no per-tenant configuration), matching the confirmed P1-6 decision B.
 *
 * `resolveRetentionConfig()` is a pure function of the environment so tests can pass an explicit env
 * map and assert defaults / overrides without touching process.env.
 */

export interface RetentionConfig {
  /** Age (days) beyond which live sensitive raw content is redacted by the sweep. */
  rawContentDays: number;
}

export const RETENTION_DEFAULTS: RetentionConfig = {
  // Provisional default — pending APPI legal review. See file header.
  rawContentDays: 30,
};

type Env = Record<string, string | undefined>;

/** Parse a positive number from env, falling back to `def` on missing / NaN / non-positive. */
function posNum(raw: string | undefined, def: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/**
 * Resolve the effective retention window from an env map (defaults to process.env). Pure: no side
 * effects, same input → same output. Env key: RETENTION_RAW_CONTENT_DAYS.
 */
export function resolveRetentionConfig(env: Env = process.env): RetentionConfig {
  return {
    rawContentDays: posNum(env.RETENTION_RAW_CONTENT_DAYS, RETENTION_DEFAULTS.rawContentDays),
  };
}
