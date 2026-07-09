import type { RankedRecommendation, RecommendationCandidate, Severity } from '@clearview/shared';

const SEVERITY_WEIGHT: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const DEFAULT_CAP = 5;

/**
 * The conductor's single voice to the manager: de-duplicate, de-conflict across domains,
 * rank by severity × urgency × impact, and cap the active feed. Deterministic; this is the
 * seam where an LLM could later re-rank / plain-word the cues.
 */
export class Orchestrator {
  /**
   * @param penalties P4/S8 read-back: per-domain priority penalties learned from feedback (a domain
   *   whose cues are repeatedly ignored is subtracted from its rank score → it sinks in the feed).
   */
  orchestrate(
    candidates: RecommendationCandidate[],
    cap: number = DEFAULT_CAP,
    penalties: Record<string, number> = {},
  ): RankedRecommendation[] {
    // 1) De-duplicate: same domain + object + title.
    const deduped = new Map<string, RecommendationCandidate>();
    for (const c of candidates) {
      const key = `${c.domain}|${c.objectId}|${c.title}`;
      if (!deduped.has(key)) deduped.set(key, c);
    }
    const scored = [...deduped.values()].map((c) => ({
      ...c,
      // severity × impact, minus any learned downgrade for this domain (bounded in learn).
      score: SEVERITY_WEIGHT[c.severity] * (c.impact ?? 1) - (penalties[c.domain] ?? 0),
    }));

    // 2) De-conflict: candidates contending for the same resource → keep the top-scored,
    //    annotate the trade-off, drop the losers from the active feed.
    const byResource = new Map<string, typeof scored>();
    for (const c of scored) {
      if (!c.resourceKey) continue;
      const list = byResource.get(c.resourceKey) ?? [];
      list.push(c);
      byResource.set(c.resourceKey, list);
    }
    const superseded = new Set<(typeof scored)[number]>();
    const tradeoffs = new Map<(typeof scored)[number], string>();
    for (const list of byResource.values()) {
      if (list.length < 2) continue;
      const sorted = [...list].sort((a, b) => b.score - a.score);
      const [winner, ...losers] = sorted;
      if (!winner) continue;
      tradeoffs.set(winner, `trade-off: also affects ${losers.map((l) => l.title).join('; ')}`);
      for (const l of losers) superseded.add(l);
    }

    // 3) Rank (desc by score, then confidence) and cap.
    const ranked = scored
      .filter((c) => !superseded.has(c))
      .sort((a, b) => b.score - a.score || b.confidence - a.confidence)
      .slice(0, cap)
      .map((c, i) => {
        const tradeoff = tradeoffs.get(c);
        return { ...c, rank: i + 1, ...(tradeoff ? { tradeoff } : {}) } as RankedRecommendation;
      });
    return ranked;
  }
}
