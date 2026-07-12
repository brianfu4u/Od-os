import { Injectable } from '@nestjs/common';
import type { OpsSummary } from '@clearview/shared';
import { buildVersionInfo } from '../health/health.status';
import { pingDatabase } from '../database/pool';
import { metrics } from './metrics.registry';
import { OpsRepository } from './ops.repository';

/**
 * Assembles the manager-only ops summary: deploy version, a DB connectivity check, the process-level
 * metrics snapshot (requests/latency/errors + LLM/STT + sweep/verify + recent errors), and a
 * tenant-scoped activity roll-up (via RLS). Read-only end to end.
 */
@Injectable()
export class OpsService {
  constructor(private readonly repo: OpsRepository) {}

  async summary(tenantId: string, now: Date = new Date()): Promise<OpsSummary> {
    const ping = await pingDatabase();
    const tenant = await this.repo.tenantCounts(tenantId);
    return {
      version: buildVersionInfo(),
      db: { ok: ping.ok, latencyMs: ping.latencyMs },
      metrics: metrics.snapshot(now.getTime()),
      tenant,
      generatedAt: now.toISOString(),
    };
  }
}
