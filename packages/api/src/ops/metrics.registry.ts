/**
 * In-memory, process-level metrics — deliberately zero-dependency (no prom-client etc., which the
 * sandbox/CI cannot install). It is a plain module singleton (not a Nest provider) so the global
 * interceptor/filter and the two external-call adapters can record into it with a bare import and no
 * DI wiring. Counters are process-lifetime and reset on restart; that is the accepted trade-off for a
 * thin pilot observability layer (a durable/Prometheus backend is a later ticket).
 *
 * READ-ONLY w.r.t. business state: nothing here touches the DB, the ontology, or verified_state.
 * NO PHI / IDs: routes are normalized to templates (UUID/numeric segments → ':id') so neither raw
 * identifiers nor unbounded-cardinality keys are ever stored.
 */

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_HEX = /^[0-9a-f]{16,}$/i;

/** Collapse identifier-bearing path segments to ':id' → bounded cardinality + no raw ids in metrics. */
export function normalizePath(path: string): string {
  const clean = (path || '/').split('?')[0]!.split('#')[0]!;
  const segs = clean.split('/').map((s) => {
    if (!s) return s;
    if (UUID_SEG.test(s) || LONG_HEX.test(s) || /^\d+$/.test(s)) return ':id';
    return s;
  });
  const joined = segs.join('/');
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined || '/';
}

export interface RouteStat {
  route: string;
  count: number;
  serverErrors: number;
  avgMs: number;
  maxMs: number;
}
export interface ErrorSample {
  at: string;
  requestId?: string;
  tenantId?: string;
  method?: string;
  route?: string;
  status: number;
  name: string;
  message: string;
}
export interface MetricsSnapshot {
  uptimeSec: number;
  http: { total: number; serverErrors: number; byRoute: RouteStat[] };
  llm: { calls: number; failures: number };
  stt: { calls: number; failures: number };
  derived: { sweepRuns: number; verifyRequests: number };
  recentErrors: ErrorSample[];
}

interface RouteAgg {
  count: number;
  serverErrors: number;
  latSum: number;
  latMax: number;
}

const RECENT_ERRORS_CAP = 50;
const BY_ROUTE_CAP = 50;

class MetricsRegistry {
  private started = Date.now();
  private byRoute = new Map<string, RouteAgg>();
  private llmCalls = 0;
  private llmFailures = 0;
  private sttCalls = 0;
  private sttFailures = 0;
  private errors: ErrorSample[] = [];

  recordHttp(method: string, path: string, status: number, ms: number): void {
    const key = `${(method || 'GET').toUpperCase()} ${normalizePath(path)}`;
    const a = this.byRoute.get(key) ?? { count: 0, serverErrors: 0, latSum: 0, latMax: 0 };
    a.count += 1;
    if (status >= 500) a.serverErrors += 1;
    const d = Number.isFinite(ms) && ms >= 0 ? ms : 0;
    a.latSum += d;
    if (d > a.latMax) a.latMax = d;
    this.byRoute.set(key, a);
  }

  recordLlmCall(): void {
    this.llmCalls += 1;
  }
  recordLlmFailure(): void {
    this.llmFailures += 1;
  }
  recordSttCall(): void {
    this.sttCalls += 1;
  }
  recordSttFailure(): void {
    this.sttFailures += 1;
  }

  recordError(sample: ErrorSample): void {
    this.errors.unshift(sample);
    if (this.errors.length > RECENT_ERRORS_CAP) this.errors.length = RECENT_ERRORS_CAP;
  }

  snapshot(now: number = Date.now()): MetricsSnapshot {
    let total = 0;
    let serverErrors = 0;
    const routes: RouteStat[] = [];
    let sweepRuns = 0;
    let verifyRequests = 0;
    for (const [route, a] of this.byRoute) {
      total += a.count;
      serverErrors += a.serverErrors;
      routes.push({
        route,
        count: a.count,
        serverErrors: a.serverErrors,
        avgMs: a.count ? Math.round((a.latSum / a.count) * 10) / 10 : 0,
        maxMs: Math.round(a.latMax * 10) / 10,
      });
      if (route.startsWith('POST ') && route.endsWith('/sweep')) sweepRuns += a.count;
      if (route === 'POST /objects/:id/verify') verifyRequests += a.count;
    }
    routes.sort((x, y) => y.count - x.count);
    return {
      uptimeSec: Math.max(0, Math.round((now - this.started) / 1000)),
      http: { total, serverErrors, byRoute: routes.slice(0, BY_ROUTE_CAP) },
      llm: { calls: this.llmCalls, failures: this.llmFailures },
      stt: { calls: this.sttCalls, failures: this.sttFailures },
      derived: { sweepRuns, verifyRequests },
      recentErrors: this.errors.slice(),
    };
  }

  /** Test-only: wipe all counters. */
  reset(now: number = Date.now()): void {
    this.started = now;
    this.byRoute.clear();
    this.llmCalls = this.llmFailures = this.sttCalls = this.sttFailures = 0;
    this.errors = [];
  }
}

/** The process-wide singleton. Import and record; no DI needed. */
export const metrics = new MetricsRegistry();
