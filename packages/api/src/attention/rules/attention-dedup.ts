/**
 * T-06 DISPLAY-LAYER dedup/cooldown — pure functions, presentation only.
 *
 * CRITICAL SEPARATION (product rule): this dedup runs ONLY on the queue's presentation path, AFTER
 * the audit layer has already logged every candidate (T-10). It exists purely to avoid flooding the
 * manager's list; it must NEVER be used to decide whether to write an audit event. "Only state
 * facts, log everything" — dropping happens at display, never at the write layer.
 *
 * Two operations:
 *   1) collapse: same employee + same kind → one item (stable id = `<employeeId>:<kind>`).
 *   2) cooldown: when several candidates of the same (employee, kind) exist within one read, we keep
 *      the freshest and treat the display cooldown window as the "same finding" horizon. Because P0
 *      is stateless/read-time, there is no cross-read suppression store — the cooldown simply governs
 *      how a burst within a single snapshot collapses, keeping the manager view stable.
 */
import type { AttentionCandidate, AttentionItem } from '@clearview/shared';
import { attentionItemId } from '@clearview/shared';

/** ISO → epoch ms, or null. */
function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Collapse candidates to manager-facing items: one row per (employeeId, kind), keeping the freshest
 * by generatedAt (tie-broken by lastEventAt). Order is stable: by employeeName then kind.
 */
export function dedupForDisplay(candidates: AttentionCandidate[]): AttentionItem[] {
  const best = new Map<string, AttentionCandidate>();
  for (const c of candidates) {
    const key = attentionItemId(c.employeeId, c.kind);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, c);
      continue;
    }
    const a = ms(c.generatedAt) ?? ms(c.lastEventAt) ?? 0;
    const b = ms(prev.generatedAt) ?? ms(prev.lastEventAt) ?? 0;
    if (a >= b) best.set(key, c);
  }

  const items: AttentionItem[] = [...best.values()].map((c) => ({
    id: attentionItemId(c.employeeId, c.kind),
    employeeId: c.employeeId,
    employeeName: c.employeeName,
    kind: c.kind,
    evidenceSummary: c.evidenceSummary,
    lastEventAt: c.lastEventAt,
    generatedAt: c.generatedAt,
  }));

  items.sort((x, y) => {
    const byName = x.employeeName.localeCompare(y.employeeName);
    return byName !== 0 ? byName : x.kind.localeCompare(y.kind);
  });
  return items;
}
