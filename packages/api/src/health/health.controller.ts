import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { buildLiveness, buildReadiness, type LivenessReport, type ReadinessReport } from './health.status';
import { pingDatabase } from '../database/pool';

/**
 * Public, unauthenticated health surface (carries NO tenant data / PHI / secret):
 *  - GET /health       liveness — process is up; returns version (commit/build) + uptime. Always 200
 *                      if the process can answer. Use this for Render's health check + "which build?".
 *  - GET /health/ready readiness — also pings the DB (SELECT 1). 200 when reachable, 503 (degraded)
 *                      when not; use for deploy smoke / readiness gating without killing a live pod.
 */
@Controller('health')
export class HealthController {
  @Get()
  liveness(): LivenessReport {
    return buildLiveness(process.uptime());
  }

  @Get('ready')
  async readiness(): Promise<ReadinessReport> {
    const ping = await pingDatabase();
    const report = buildReadiness(ping);
    if (!ping.ok) throw new ServiceUnavailableException(report);
    return report;
  }
}
