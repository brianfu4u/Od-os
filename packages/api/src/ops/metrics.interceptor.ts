import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { randomUUID } from 'node:crypto';
import { metrics, normalizePath } from './metrics.registry';
import { httpLogRecord } from './log';

/** Infra probe paths — excluded from metrics + the access log so frequent health checks don't
 * flood the log or inflate the "requests" count (they are not application traffic). */
const PROBE_ROUTES = new Set(['/health', '/health/ready']);

/** Minimal structural request/response shapes (avoids an express type dependency). */
interface ReqLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  tenantId?: string;
  auth?: { tenantId?: string };
  requestId?: string;
}
interface ResLike {
  statusCode?: number;
  headersSent?: boolean;
  getHeader?(name: string): unknown;
  setHeader?(name: string, value: string): void;
}

/** True once the response has started streaming (SSE) or headers are already flushed — any header
 * write after this throws "Cannot set headers after they are sent". SSE endpoints (@Sse) flush a
 * `text/event-stream` head immediately, so we must never touch headers or run per-emit finish on them. */
function isStreamingResponse(res: ResLike): boolean {
  if (res.headersSent === true) return true;
  const ct = res.getHeader?.('content-type');
  return typeof ct === 'string' && ct.includes('text/event-stream');
}

/**
 * Global request instrumentation: assigns a request id (echoed as X-Request-Id), records per-route
 * count/latency/errors into the in-memory registry, and emits ONE structured, body-free access log
 * line per request. Read-only — it never touches business state. tenantId (when present) is read
 * from what TenantGuard resolved; no client-supplied identity is trusted here.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  private readonly logger = new Logger('http');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const res = http.getResponse<ResLike>();

    const start = Date.now();
    const requestId = req.requestId ?? randomUUID();
    req.requestId = requestId;
    // Never set a header on a response whose head is already sent (SSE stream) — that throws
    // "Cannot set headers after they are sent", which @Sse surfaces to the client as an error event.
    if (!isStreamingResponse(res)) res.setHeader?.('X-Request-Id', requestId);

    const method = (req.method ?? 'GET').toUpperCase();
    const rawPath = req.originalUrl ?? req.url ?? '/';
    const route = normalizePath(rawPath);
    const isProbe = PROBE_ROUTES.has(route);

    const finish = (status: number): void => {
      if (isProbe) return; // don't count/log infra health probes
      const ms = Date.now() - start;
      metrics.recordHttp(method, rawPath, status, ms);
      const tenantId = req.tenantId ?? req.auth?.tenantId;
      this.logger.log(JSON.stringify(httpLogRecord({ method, route, status, ms, requestId, tenantId })));
    };

    // SSE streams emit many events over one open response. Counting/logging per emit would flood the
    // access log and re-run finish() against an open stream; record once when the stream terminates.
    let done = false;
    const finishOnce = (status: number): void => {
      if (done) return;
      done = true;
      finish(status);
    };

    return next.handle().pipe(
      tap({
        next: () => {
          if (isStreamingResponse(res)) return; // SSE: defer to complete/error, don't finish per event
          finish(typeof res.statusCode === 'number' ? res.statusCode : 200);
        },
        error: (err: unknown) => {
          const status = (err as { status?: unknown })?.status;
          finishOnce(typeof status === 'number' ? status : 500);
        },
        complete: () => {
          if (isStreamingResponse(res)) finishOnce(typeof res.statusCode === 'number' ? res.statusCode : 200);
        },
      }),
    );
  }
}
