import { describe, it, expect } from 'vitest';
import { buildHealthStatus } from './health.status';

describe('buildHealthStatus', () => {
  it('returns ok with the service name and an ISO timestamp', () => {
    const status = buildHealthStatus(new Date('2026-07-07T00:00:00.000Z'));
    expect(status.status).toBe('ok');
    expect(status.service).toBe('clearview-od-api');
    expect(status.timestamp).toBe('2026-07-07T00:00:00.000Z');
  });
});
