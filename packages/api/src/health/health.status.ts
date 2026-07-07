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
