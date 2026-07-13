import { describe, it, expect } from 'vitest';
import { of, firstValueFrom, lastValueFrom, toArray } from 'rxjs';
import type { ArgumentsHost, CallHandler, ExecutionContext } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { MetricsInterceptor } from './metrics.interceptor';
import { AllExceptionsFilter } from './all-exceptions.filter';

/**
 * Regression: the SSE endpoint (@Sse /objects/stream) once emitted a client-visible
 * `event: error / data: Cannot set headers after they are sent to the client`. Root cause was two
 * global layers touching an already-flushed response: the MetricsInterceptor set X-Request-Id and
 * ran a per-emit finish(), and the AllExceptionsFilter tried to write a JSON body. These tests pin
 * the guards that make both layers no-op once the response head is sent / is an SSE stream.
 */

interface FakeRes {
  statusCode?: number;
  headersSent?: boolean;
  _headers: Record<string, string>;
  getHeader(name: string): unknown;
  setHeader(name: string, value: string): void;
  status(code: number): FakeRes;
  json(body: unknown): void;
  _json?: unknown;
}

function makeRes(init: Partial<FakeRes> = {}): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    headersSent: false,
    _headers: {},
    getHeader(name) {
      return this._headers[name.toLowerCase()];
    },
    setHeader(name, value) {
      // Mirror Express: writing a header after the head is sent is a hard error.
      if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
      this._headers[name.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this._json = body;
    },
    ...init,
  };
  return res;
}

function ctx(res: FakeRes, req: Record<string, unknown> = { method: 'GET', url: '/objects/stream' }): ExecutionContext {
  const http = { getRequest: () => req, getResponse: () => res };
  return {
    getType: () => 'http',
    switchToHttp: () => http,
  } as unknown as ExecutionContext;
}

describe('MetricsInterceptor · SSE safety', () => {
  it('does not set X-Request-Id on an SSE response (head already streaming)', async () => {
    const res = makeRes({ _headers: { 'content-type': 'text/event-stream' } });
    const interceptor = new MetricsInterceptor();
    const handler: CallHandler = { handle: () => of({ hello: 1 }, { hello: 2 }) };

    // Must not throw, and must not have written the request-id header on the stream.
    const out = await lastValueFrom(interceptor.intercept(ctx(res), handler).pipe(toArray()));
    expect(out).toHaveLength(2);
    expect(res._headers['x-request-id']).toBeUndefined();
  });

  it('sets X-Request-Id normally on a non-SSE JSON response', async () => {
    const res = makeRes();
    const interceptor = new MetricsInterceptor();
    const handler: CallHandler = { handle: () => of({ ok: true }) };
    await firstValueFrom(interceptor.intercept(ctx(res, { method: 'GET', url: '/overview' }), handler));
    expect(res._headers['x-request-id']).toBeTypeOf('string');
  });

  it('never throws even if the response head is already sent mid-stream', async () => {
    const res = makeRes({ headersSent: true });
    const interceptor = new MetricsInterceptor();
    const handler: CallHandler = { handle: () => of(1, 2, 3) };
    await expect(lastValueFrom(interceptor.intercept(ctx(res), handler).pipe(toArray()))).resolves.toEqual([1, 2, 3]);
  });
});

describe('AllExceptionsFilter · SSE safety', () => {
  function host(res: FakeRes, req: Record<string, unknown> = { method: 'GET', url: '/objects/stream' }): ArgumentsHost {
    const http = { getRequest: () => req, getResponse: () => res };
    return { getType: () => 'http', switchToHttp: () => http } as unknown as ArgumentsHost;
  }

  it('does NOT write status/body when the response head is already sent (SSE mid-flight error)', () => {
    const res = makeRes({ headersSent: true });
    const filter = new AllExceptionsFilter();
    // Would previously throw "Cannot set headers..." via res.status().json(); now it must be a no-op.
    expect(() => filter.catch(new Error('stream blew up'), host(res))).not.toThrow();
    expect(res._json).toBeUndefined();
  });

  it('still writes a sanitized JSON error for a normal (head-not-sent) request', () => {
    const res = makeRes({ headersSent: false });
    const filter = new AllExceptionsFilter();
    filter.catch(new HttpException('nope', 401), host(res, { method: 'GET', url: '/overview' }));
    expect(res.statusCode).toBe(401);
    expect(res._json).toBeDefined();
  });
});
