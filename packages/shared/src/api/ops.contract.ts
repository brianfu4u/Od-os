/**
 * Ops observability contract (feat/ops-observability) — shapes shared by api + web for the
 * manager-only ops view. All fields are operational metadata only: NO PHI, NO secrets, and routes
 * are normalized templates (never raw ids).
 */

export interface OpsVersion {
  commit: string;
  buildTime: string | null;
  nodeEnv: string;
}

export interface OpsRouteStat {
  route: string; // e.g. "POST /objects/:id/verify" — normalized, no raw ids
  count: number;
  serverErrors: number;
  avgMs: number;
  maxMs: number;
}

export interface OpsErrorSample {
  at: string;
  requestId?: string;
  tenantId?: string;
  method?: string;
  route?: string;
  status: number;
  name: string;
  message: string; // scrubbed of credential patterns; no body
}

export interface OpsMetrics {
  uptimeSec: number;
  http: { total: number; serverErrors: number; byRoute: OpsRouteStat[] };
  llm: { calls: number; failures: number };
  stt: { calls: number; failures: number };
  derived: { sweepRuns: number; verifyRequests: number };
  recentErrors: OpsErrorSample[];
}

/** Tenant-scoped business activity (last N hours), aggregated under withTenant/RLS. */
export interface OpsTenantCounts {
  windowHours: number;
  reports: number;
  verdicts: number;
  transcriptions: number;
  llmAnalyses: number;
  actions: number;
}

export interface OpsSummary {
  version: OpsVersion;
  db: { ok: boolean; latencyMs: number | null };
  metrics: OpsMetrics; // process-level (not tenant-scoped)
  tenant: OpsTenantCounts; // tenant-scoped via RLS
  generatedAt: string;
}
