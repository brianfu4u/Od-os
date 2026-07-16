/**
 * Attention-rule thresholds (T-07). Every threshold is env-configurable — NEVER hardcoded — so a
 * clinic can tune sensitivity without a redeploy. Defaults are the numbers confirmed with the
 * product owner:
 *   - silence:        3600s (1h)   — on_duty with no valid event for this long → silence
 *   - busy window:     600s (10m)  — busy but no corroborating activity in this window → inconsistency
 *   - scan follow-up: 1800s (30m)  — a scan with no patient-flow progress within this window → no_followup
 *   - low confidence:  0.60        — verification_score below this (or verdict 'inconsistent') → low_confidence
 *   - display cooldown 7200s (2h)  — QUEUE display-layer dedup window (T-06 only). NOTE: this NEVER
 *                                    gates the audit write — every candidate is still logged (T-10).
 *
 * `resolveAttentionConfig()` is a pure function of the environment, so tests can pass an explicit
 * env map and assert defaults / overrides without touching process.env.
 */

export interface AttentionConfig {
  /** on_duty silence threshold, seconds. */
  silenceSeconds: number;
  /** busy-without-activity window, seconds. */
  busyInconsistencySeconds: number;
  /** scan-without-follow-up window, seconds. */
  scanFollowupSeconds: number;
  /** verification confidence floor (0..1); at/above is fine, below trips low_confidence. */
  lowConfidenceThreshold: number;
  /** QUEUE display-layer dedup cooldown, seconds. Presentation only — never gates audit writes. */
  displayCooldownSeconds: number;
}

export const ATTENTION_DEFAULTS: AttentionConfig = {
  silenceSeconds: 3600,
  busyInconsistencySeconds: 600,
  scanFollowupSeconds: 1800,
  lowConfidenceThreshold: 0.6,
  displayCooldownSeconds: 7200,
};

type Env = Record<string, string | undefined>;

/** Parse a positive number from env, falling back to `def` on missing / NaN / non-positive. */
function posNum(raw: string | undefined, def: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

/** Parse a 0..1 fraction from env, clamped; falls back to `def` on missing / NaN. */
function fraction(raw: string | undefined, def: number): number {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(1, Math.max(0, n));
}

/**
 * Resolve the effective thresholds from an env map (defaults to process.env). Pure: no side effects,
 * same input → same output. Env keys:
 *   ATTENTION_SILENCE_SECONDS, ATTENTION_BUSY_WINDOW_SECONDS, ATTENTION_SCAN_FOLLOWUP_SECONDS,
 *   ATTENTION_LOW_CONFIDENCE_THRESHOLD, ATTENTION_DISPLAY_COOLDOWN_SECONDS.
 */
export function resolveAttentionConfig(env: Env = process.env): AttentionConfig {
  return {
    silenceSeconds: posNum(env.ATTENTION_SILENCE_SECONDS, ATTENTION_DEFAULTS.silenceSeconds),
    busyInconsistencySeconds: posNum(
      env.ATTENTION_BUSY_WINDOW_SECONDS,
      ATTENTION_DEFAULTS.busyInconsistencySeconds,
    ),
    scanFollowupSeconds: posNum(env.ATTENTION_SCAN_FOLLOWUP_SECONDS, ATTENTION_DEFAULTS.scanFollowupSeconds),
    lowConfidenceThreshold: fraction(
      env.ATTENTION_LOW_CONFIDENCE_THRESHOLD,
      ATTENTION_DEFAULTS.lowConfidenceThreshold,
    ),
    displayCooldownSeconds: posNum(
      env.ATTENTION_DISPLAY_COOLDOWN_SECONDS,
      ATTENTION_DEFAULTS.displayCooldownSeconds,
    ),
  };
}
