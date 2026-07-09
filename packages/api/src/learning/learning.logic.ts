import type { LearningChange } from '@clearview/shared';
import { LEARNING, clamp, round3, stepToward } from './learning-config';

/** The feedback fields the learner consumes (a projection of a learning_feedback row). */
export interface LearnFeedback {
  kind:
    | 'recommendation_approved'
    | 'recommendation_dismissed'
    | 'recommendation_snoozed'
    | 'recommendation_undone'
    | 'verdict_correction';
  domain?: string | null;
  taskType?: string | null;
  toState?: string | null;
  evidenceKinds?: string[];
}

/** Current effective values, resolved by the caller (learning_params override ?? S0-7 default). */
export interface CurrentResolvers {
  weight: (taskType: string, kind: string) => number;
  threshold: (taskType: string) => number;
  penalty: (domain: string) => number;
}

const NEGATIVE_STATES = new Set(['conflict', 'unverified']);

/**
 * PURE deterministic learner. Aggregates feedback and returns BOUNDED changes — each a small step
 * toward a target derived from the aggregate, clamped to config bounds, and only when the relevant
 * sample ≥ minSample. Sorted output for determinism. No I/O.
 *
 *  • domain priority: a domain whose cues are mostly ignored (dismissed/undone) accrues a downgrade
 *    penalty proportional to the ignore-ratio; a mostly-approved domain relaxes back toward 0.
 *  • task evidence weight: verdict corrections toward 'verified' when an evidence kind was present
 *    nudge that kind's weight UP (it correlated with real completion); corrections toward
 *    conflict/unverified nudge it DOWN.
 *  • task threshold: corrections that flip a prior 'verified' to conflict/unverified raise the bar;
 *    corrections toward 'verified' lower it.
 */
export function computeAdjustments(feedback: LearnFeedback[], current: CurrentResolvers): LearningChange[] {
  const changes: LearningChange[] = [];

  // ── A) domain priority penalty ──────────────────────────────────────────────
  const domainPos = new Map<string, number>();
  const domainNeg = new Map<string, number>();
  for (const f of feedback) {
    if (!f.domain) continue;
    if (f.kind === 'recommendation_approved') domainPos.set(f.domain, (domainPos.get(f.domain) ?? 0) + 1);
    else if (f.kind === 'recommendation_dismissed' || f.kind === 'recommendation_undone')
      domainNeg.set(f.domain, (domainNeg.get(f.domain) ?? 0) + 1);
  }
  for (const domain of [...new Set([...domainPos.keys(), ...domainNeg.keys()])].sort()) {
    const pos = domainPos.get(domain) ?? 0;
    const neg = domainNeg.get(domain) ?? 0;
    const total = pos + neg;
    if (total < LEARNING.minSample) continue; // low-sample guard
    const ignoreRatio = neg / total;
    const target = clamp((ignoreRatio - LEARNING.ignoreRatioFloor) * 2 * LEARNING.penalty.max, LEARNING.penalty.min, LEARNING.penalty.max);
    const cur = current.penalty(domain);
    const next = round3(clamp(stepToward(cur, target, LEARNING.penalty.step), LEARNING.penalty.min, LEARNING.penalty.max));
    if (next !== round3(cur)) {
      changes.push({
        paramType: 'domain_priority', paramKey: domain, field: 'penalty', before: round3(cur), after: next,
        basis: { sampleSize: total, signal: `ignoreRatio=${round3(ignoreRatio)}`, detail: `pos=${pos} neg=${neg}` },
      });
    }
  }

  // ── B) task evidence weights + C) task thresholds (verdict corrections) ──────
  const kindVotes = new Map<string, number>(); // `${taskType}|${evidenceKind}` → net vote
  const kindSample = new Map<string, number>();
  const taskVotes = new Map<string, number>(); // taskType → net vote (threshold direction)
  const taskSample = new Map<string, number>();
  for (const f of feedback) {
    if (f.kind !== 'verdict_correction' || !f.taskType || !f.toState) continue;
    const toVerified = f.toState === 'verified';
    const toNegative = NEGATIVE_STATES.has(f.toState);
    if (!toVerified && !toNegative) continue;
    // threshold: toward verified → bar was too high → LOWER (-1); toward negative → RAISE (+1).
    taskVotes.set(f.taskType, (taskVotes.get(f.taskType) ?? 0) + (toVerified ? -1 : 1));
    taskSample.set(f.taskType, (taskSample.get(f.taskType) ?? 0) + 1);
    // weights: an evidence kind present at a correction toward verified → +1; toward negative → -1.
    for (const k of f.evidenceKinds ?? []) {
      const key = `${f.taskType}|${k}`;
      kindVotes.set(key, (kindVotes.get(key) ?? 0) + (toVerified ? 1 : -1));
      kindSample.set(key, (kindSample.get(key) ?? 0) + 1);
    }
  }

  for (const key of [...kindVotes.keys()].sort()) {
    const sample = kindSample.get(key) ?? 0;
    if (sample < LEARNING.minSample) continue;
    const net = kindVotes.get(key) ?? 0;
    const dir = Math.sign(net);
    if (dir === 0) continue;
    const [taskType, kind] = key.split('|') as [string, string];
    const cur = current.weight(taskType, kind);
    const next = round3(clamp(cur + dir * LEARNING.weight.step, LEARNING.weight.min, LEARNING.weight.max));
    if (next !== round3(cur)) {
      changes.push({
        paramType: 'task', paramKey: taskType, field: `weights.${kind}`, before: round3(cur), after: next,
        basis: { sampleSize: sample, signal: `netVote=${net}`, detail: dir > 0 ? 'evidence correlated with completion' : 'evidence correlated with non-completion' },
      });
    }
  }

  for (const taskType of [...taskVotes.keys()].sort()) {
    const sample = taskSample.get(taskType) ?? 0;
    if (sample < LEARNING.minSample) continue;
    const net = taskVotes.get(taskType) ?? 0;
    const dir = Math.sign(net);
    if (dir === 0) continue;
    const cur = current.threshold(taskType);
    const next = round3(clamp(cur + dir * LEARNING.threshold.step, LEARNING.threshold.min, LEARNING.threshold.max));
    if (next !== round3(cur)) {
      changes.push({
        paramType: 'task', paramKey: taskType, field: 'threshold', before: round3(cur), after: next,
        basis: { sampleSize: sample, signal: `netVote=${net}`, detail: dir > 0 ? 'raise bar (false verifieds)' : 'lower bar (false conflicts)' },
      });
    }
  }

  return changes;
}
