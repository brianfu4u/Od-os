import { describe, it, expect } from 'vitest';
import { buildHealthStatus, buildVersionInfo, buildLiveness, buildReadiness } from './health.status';

describe('buildHealthStatus', () => {
  it('returns ok with the service name and an ISO timestamp', () => {
    const status = buildHealthStatus(new Date('2026-07-07T00:00:00.000Z'));
    expect(status.status).toBe('ok');
    expect(status.service).toBe('clearview-od-api');
    expect(status.timestamp).toBe('2026-07-07T00:00:00.000Z');
  });
});

describe('buildVersionInfo', () => {
  it('reads the commit/build/env from the environment (Render + generic names)', () => {
    expect(buildVersionInfo({ RENDER_GIT_COMMIT: 'abc123', BUILD_TIME: '2026-07-12T00:00:00Z', NODE_ENV: 'production' })).toEqual({
      commit: 'abc123',
      buildTime: '2026-07-12T00:00:00Z',
      nodeEnv: 'production',
    });
    expect(buildVersionInfo({ COMMIT_SHA: 'def456' }).commit).toBe('def456');
  });
  it('falls back to safe defaults when unset', () => {
    expect(buildVersionInfo({})).toEqual({ commit: 'unknown', buildTime: null, nodeEnv: 'development' });
  });
});

describe('buildLiveness', () => {
  it('is ok, rounds uptime, and carries version', () => {
    const r = buildLiveness(123.7, { RENDER_GIT_COMMIT: 'x' }, new Date('2026-07-12T00:00:00.000Z'));
    expect(r.status).toBe('ok');
    expect(r.uptimeSec).toBe(124);
    expect(r.version.commit).toBe('x');
    expect(r.timestamp).toBe('2026-07-12T00:00:00.000Z');
  });
});

describe('buildReadiness', () => {
  it('is ok when the DB ping succeeds', () => {
    const r = buildReadiness({ ok: true, latencyMs: 5 }, {});
    expect(r.status).toBe('ok');
    expect(r.db).toEqual({ ok: true, latencyMs: 5 });
  });
  it('is degraded and carries the error when the DB ping fails', () => {
    const r = buildReadiness({ ok: false, latencyMs: null, error: 'ECONNREFUSED' }, {});
    expect(r.status).toBe('degraded');
    expect(r.db).toEqual({ ok: false, latencyMs: null, error: 'ECONNREFUSED' });
  });
});
