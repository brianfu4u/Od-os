import { describe, it, expect, beforeEach } from 'vitest';
import { metrics, normalizePath } from './metrics.registry';

describe('normalizePath', () => {
  it('collapses uuid / numeric / long-hex segments to :id and strips query/hash', () => {
    expect(normalizePath('/objects/11111111-1111-1111-1111-111111111111/verify')).toBe('/objects/:id/verify');
    expect(normalizePath('/recommendations/123/approve')).toBe('/recommendations/:id/approve');
    expect(normalizePath('/objects/deadbeefdeadbeef99')).toBe('/objects/:id');
    expect(normalizePath('/health?x=1#f')).toBe('/health');
    expect(normalizePath('/')).toBe('/');
  });
});

describe('metrics registry', () => {
  beforeEach(() => metrics.reset(0));

  it('aggregates per-route count/latency/errors and derives sweep/verify', () => {
    metrics.recordHttp('get', '/overview', 200, 12);
    metrics.recordHttp('GET', '/overview', 500, 30);
    metrics.recordHttp('POST', '/recommendations/sweep', 200, 5);
    metrics.recordHttp('POST', '/verifications/sweep', 200, 7);
    metrics.recordHttp('POST', '/objects/11111111-1111-1111-1111-111111111111/verify', 200, 9);
    const s = metrics.snapshot(5000);
    expect(s.http.total).toBe(5);
    expect(s.http.serverErrors).toBe(1);
    const ov = s.http.byRoute.find((r) => r.route === 'GET /overview')!;
    expect(ov).toMatchObject({ count: 2, serverErrors: 1, avgMs: 21, maxMs: 30 });
    expect(s.derived.sweepRuns).toBe(2);
    expect(s.derived.verifyRequests).toBe(1);
    expect(s.uptimeSec).toBe(5);
  });

  it('never stores raw ids in the snapshot (paths are normalized)', () => {
    metrics.recordHttp('POST', '/objects/abc11111-1111-1111-1111-111111111111/verify', 200, 3);
    expect(JSON.stringify(metrics.snapshot())).not.toContain('abc11111-1111');
  });

  it('counts llm/stt calls + failures', () => {
    metrics.recordLlmCall();
    metrics.recordLlmCall();
    metrics.recordLlmFailure();
    metrics.recordSttCall();
    metrics.recordSttFailure();
    const s = metrics.snapshot();
    expect(s.llm).toEqual({ calls: 2, failures: 1 });
    expect(s.stt).toEqual({ calls: 1, failures: 1 });
  });

  it('bounds the recent-errors ring at 50 (newest first)', () => {
    for (let i = 0; i < 60; i++) metrics.recordError({ at: 't', status: 500, name: 'E', message: String(i) });
    const errs = metrics.snapshot().recentErrors;
    expect(errs.length).toBe(50);
    expect(errs[0]!.message).toBe('59');
  });
});
