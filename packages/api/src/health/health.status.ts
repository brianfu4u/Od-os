type Env = Record<string, string | undefined>;

export interface HealthStatus {
  status: 'ok';
  service: 'clearview-od-api';
  timestamp: string;
}

/**
 * Pure liveness payload builder. Kept free of decorators/DI so it can be unit
 * tested with plain vitest (no Nest testing module / metadata reflection needed).
 */
export function buildHealthStatus(now: Date = new Date()): HealthStatus {
  return {
    status: 'ok',
    service: 'clearview-od-api',
    timestamp: now.toISOString(),
  };
}

/** Deploy version info — answers "which build is actually running?" (an old ops pain point). */
export interface VersionInfo {
  /** Short/long commit sha injected at build/deploy time; 'unknown' when unset. */
  commit: string;
  /** ISO build time when injected; null otherwise. */
  buildTime: string | null;
  nodeEnv: string;
}

/**
 * Read version info from the environment. Accepts the platform-provided names (Render sets
 * RENDER_GIT_COMMIT) plus generic fallbacks so any CI can inject it. No secret is read here.
 */
export function buildVersionInfo(env: Env = process.env): VersionInfo {
  const commit =
    env.RENDER_GIT_COMMIT || env.GIT_COMMIT || env.COMMIT_SHA || env.SOURCE_VERSION || 'unknown';
  const buildTime = env.BUILD_TIME || env.RENDER_BUILD_TIME || null;
  return { commit, buildTime, nodeEnv: env.NODE_ENV || 'development' };
}

export interface LivenessReport {
  status: 'ok';
  service: 'clearview-od-api';
  version: VersionInfo;
  uptimeSec: number;
  timestamp: string;
}

/** Liveness = the process is up. Always 'ok' if it can answer; carries version + uptime. */
export function buildLiveness(uptimeSec: number, env: Env = process.env, now: Date = new Date()): LivenessReport {
  return {
    status: 'ok',
    service: 'clearview-od-api',
    version: buildVersionInfo(env),
    uptimeSec: Math.max(0, Math.round(uptimeSec)),
    timestamp: now.toISOString(),
  };
}

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  service: 'clearview-od-api';
  db: { ok: boolean; latencyMs: number | null; error?: string };
  version: VersionInfo;
  timestamp: string;
}

/**
 * Readiness = the process can serve traffic (DB reachable). Pure mapper from a DB-ping result to the
 * report + status, so it is unit-testable without a database. The controller supplies the ping.
 */
export function buildReadiness(
  ping: { ok: boolean; latencyMs: number | null; error?: string },
  env: Env = process.env,
  now: Date = new Date(),
): ReadinessReport {
  return {
    status: ping.ok ? 'ok' : 'degraded',
    service: 'clearview-od-api',
    db: ping.error ? { ok: ping.ok, latencyMs: ping.latencyMs, error: ping.error } : { ok: ping.ok, latencyMs: ping.latencyMs },
    version: buildVersionInfo(env),
    timestamp: now.toISOString(),
  };
}
