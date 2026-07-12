import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { metrics, normalizePath } from './metrics.registry';
import { errorSample, errorLogRecord } from './log';

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
  status?(code: number): ResLike;
  json?(body: unknown): void;
  setHeader?(name: string, value: string): void;
}

/**
 * Global exception filter: records a redacted, body-free error sample (into the log + the recent-
 * errors ring + the error counter) and returns a sanitized JSON error response. It preserves an
 * HttpException's status + client message, but for a non-HTTP (unexpected) error it returns a generic
 * 500 body — an internal error/stack is never leaked to the client. Read-only w.r.t. business state.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('error');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const http = host.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const res = http.getResponse<ResLike>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : 500;
    const method = (req.method ?? 'GET').toUpperCase();
    const route = normalizePath(req.originalUrl ?? req.url ?? '/');
    const tenantId = req.tenantId ?? req.auth?.tenantId;

    const sample = errorSample(exception, { requestId: req.requestId, tenantId, method, route, status });
    metrics.recordError(sample);
    const record = errorLogRecord(sample);
    if (status >= 500) this.logger.error(JSON.stringify(record));
    else this.logger.warn(JSON.stringify(record));

    // Client response: preserve HttpException's shape; generic body for unexpected errors.
    const body = isHttp
      ? (exception.getResponse() as unknown)
      : { statusCode: 500, error: 'Internal Server Error', requestId: req.requestId };
    if (res.status && res.json) {
      res.status(status).json(body);
    } else if (res.setHeader) {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      (res as unknown as { end?(s: string): void }).end?.(JSON.stringify(body));
    }
  }
}
