import { Controller, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId } from '../tenant/tenant.decorator';
import { RetentionService } from './retention.service';

/**
 * P1-6-b · retention sweep surface. MANAGER-ONLY.
 *
 * `POST /retention/sweep` redacts sensitive raw content (mirrored in sensitive_payloads) that is
 * older than the configured window (RETENTION_RAW_CONTENT_DAYS, default 30 — provisional, pending
 * APPI review). It uses the 0020 redact-only primitive: content is nulled, the audit skeleton is
 * untouched, DELETE is impossible. RolesGuard enforces manager (a staff caller → 403), matching
 * verifications/sweep. Periodic execution is a deployment-layer external cron calling this endpoint;
 * the app intentionally has no built-in scheduler (decision C1).
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('manager')
@Controller('retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Post('sweep')
  sweep(@TenantId() tenantId: string): Promise<{ redacted: number }> {
    return this.retention.sweep(tenantId);
  }
}
