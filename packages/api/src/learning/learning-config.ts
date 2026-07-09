/**
 * Bounds for the deterministic learner. Every adjustment is small (≤ step per run), clamped to
 * [min,max], and gated by minSample — so a handful of anomalous signals can never swing a parameter,
 * and repeated runs converge toward a bounded target rather than drifting.
 */
export const LEARNING = {
  /** Below this many relevant feedback rows, do NOT adjust (low-sample guard). */
  minSample: 4,
  /** Per-evidence-kind multiplier bounds + max move per run. 1.0 = neutral (S0-7 default). */
  weight: { min: 0.2, max: 2.0, step: 0.1 },
  /** Per-task confidence threshold bounds + max move per run. */
  threshold: { min: 0.6, max: 0.95, step: 0.05 },
  /** Per-domain recommendation priority penalty (subtracted from rank score) + max move per run. */
  penalty: { min: 0, max: 2.0, step: 0.5 },
  /** Ignore-ratio at/above which a domain starts accruing a downgrade penalty. */
  ignoreRatioFloor: 0.5,
} as const;

export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));
export const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Move `current` toward `target` by at most `step` (bounded, monotonic). */
export function stepToward(current: number, target: number, step: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}
