import { Injectable } from '@nestjs/common';
import type { OpsTenantCounts } from '@clearview/shared';
import { withTenant } from '../database/tenant-context';

/**
 * Tenant-scoped ops counts. Every query runs inside withTenant() → SET LOCAL ROLE clearview_app +
 * the tenant GUC, so RLS FORCE on the append-only ledgers restricts the counts to THIS tenant. A
 * manager of tenant A can never see tenant B's activity here — the same isolation the rest of the
 * app relies on. Read-only COUNTs only; no business state is touched.
 */
@Injectable()
export class OpsRepository {
  async tenantCounts(tenantId: string, windowHours = 24): Promise<OpsTenantCounts> {
    const hours = Number.isFinite(windowHours) && windowHours > 0 ? Math.floor(windowHours) : 24;
    return withTenant(tenantId, async (c) => {
      const countSince = async (sql: string): Promise<number> => {
        const res = await c.query<{ n: number }>(sql, [hours]);
        return Number(res.rows[0]?.n ?? 0);
      };
      const [reports, verdicts, transcriptions, llmAnalyses, actions] = await Promise.all([
        countSince(`SELECT count(*)::int AS n FROM objects WHERE type='Communication' AND created_at > now() - make_interval(hours => $1)`),
        countSince(`SELECT count(*)::int AS n FROM verification_ledger WHERE created_at > now() - make_interval(hours => $1)`),
        countSince(`SELECT count(*)::int AS n FROM transcription_log WHERE created_at > now() - make_interval(hours => $1)`),
        countSince(`SELECT count(*)::int AS n FROM llm_analysis_log WHERE created_at > now() - make_interval(hours => $1)`),
        countSince(`SELECT count(*)::int AS n FROM action_log WHERE created_at > now() - make_interval(hours => $1)`),
      ]);
      return { windowHours: hours, reports, verdicts, transcriptions, llmAnalyses, actions };
    });
  }
}
