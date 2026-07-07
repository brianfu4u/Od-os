import { Controller, Get } from '@nestjs/common';
import { buildHealthStatus, type HealthStatus } from './health.status';

@Controller('health')
export class HealthController {
  @Get()
  liveness(): HealthStatus {
    return buildHealthStatus();
  }
}
