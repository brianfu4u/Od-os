/**
 * The ONLY shapes the observability layer ever logs. Centralised + pure so "what leaves the process
 * in a log line" is one small, unit-tested surface. Both records deliberately carry NO request or
 * response body, headers, query, or params — so PHI in a payload can never reach a log line — and
 * free-text (error messages) is scrubbed of credential patterns by safeError().
 */
import { safeError } from './redact';
import type { ErrorSample } from './metrics.registry';

export interface HttpLogRecord {
  evt: 'http';
  method: string;
  route: string; // already normalized (no raw ids)
  status: number;
  ms: number;
  requestId: string;
  tenantId?: string;
}

export function httpLogRecord(p: {
  method: string;
  route: string;
  status: number;
  ms: number;
  requestId: string;
  tenantId?: string;
}): HttpLogRecord {
  return {
    evt: 'http',
    method: p.method,
    route: p.route,
    status: p.status,
    ms: p.ms,
    requestId: p.requestId,
    ...(p.tenantId ? { tenantId: p.tenantId } : {}),
  };
}

/** Build a redacted, body-free error sample for the recent-errors ring + the error log line. */
export function errorSample(
  err: unknown,
  meta: { requestId?: string; tenantId?: string; method?: string; route?: string; status?: number; now?: Date },
): ErrorSample {
  const e = safeError(err);
  const status = meta.status ?? e.status ?? 500;
  return {
    at: (meta.now ?? new Date()).toISOString(),
    ...(meta.requestId ? { requestId: meta.requestId } : {}),
    ...(meta.tenantId ? { tenantId: meta.tenantId } : {}),
    ...(meta.method ? { method: meta.method } : {}),
    ...(meta.route ? { route: meta.route } : {}),
    status,
    name: e.name,
    message: e.message,
  };
}

export interface ErrorLogRecord extends ErrorSample {
  evt: 'error';
}
export function errorLogRecord(sample: ErrorSample): ErrorLogRecord {
  return { evt: 'error', ...sample };
}
