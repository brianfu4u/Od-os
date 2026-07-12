import { describe, it, expect } from 'vitest';
import { httpLogRecord, errorSample, errorLogRecord } from './log';

describe('httpLogRecord', () => {
  it('has the expected shape and carries NO body/headers/query/params', () => {
    const rec = httpLogRecord({ method: 'POST', route: '/reports', status: 201, ms: 8, requestId: 'rid-1', tenantId: 'ten-1' });
    expect(rec).toEqual({ evt: 'http', method: 'POST', route: '/reports', status: 201, ms: 8, requestId: 'rid-1', tenantId: 'ten-1' });
    for (const forbidden of ['body', 'headers', 'query', 'params']) expect(forbidden in rec).toBe(false);
  });
  it('omits tenantId when absent', () => {
    expect('tenantId' in httpLogRecord({ method: 'GET', route: '/health', status: 200, ms: 1, requestId: 'r' })).toBe(false);
  });
});

describe('errorSample / errorLogRecord', () => {
  it('captures redacted metadata and no stack/body', () => {
    const es = errorSample(Object.assign(new Error('db token=abcdef1234567890abcdef failed'), { status: 500 }), {
      requestId: 'r2',
      tenantId: 't2',
      method: 'GET',
      route: '/ops/summary',
    });
    expect(es.status).toBe(500);
    expect(es.name).toBe('Error');
    expect(es.route).toBe('/ops/summary');
    expect(es.message).not.toContain('abcdef1234567890abcdef');
    expect('stack' in es).toBe(false);
    expect(errorLogRecord(es).evt).toBe('error');
    expect(JSON.stringify(errorLogRecord(es))).not.toContain('abcdef1234567890abcdef');
  });

  it('defaults status to 500 when neither meta nor error carries one', () => {
    expect(errorSample(new Error('x'), {}).status).toBe(500);
  });
});
