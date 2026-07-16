import { Injectable } from '@nestjs/common';
import { SensitivePayloadsRepository } from './sensitive-payloads.repository';

/**
 * P1-6-b retention service. Redacts sensitive raw content past the configured window.
 *
 * TRIGGERING (decision C1): there is NO in-app scheduler (@nestjs/schedule is deliberately not
 * introduced — that would be over-engineering for a single cleanup job and violates the minimal-
 * closed-loop principle). This is a MANAGER-triggered POST endpoint, exactly like verifications/
 * sweep. Periodic execution is delegated to a deployment-layer external cron that calls the
 * endpoint. This keeps the code simple, testable, and free of a new scheduling framework.
 */
@Injectable()
export class RetentionService {
  constructor(private readonly payloads: SensitivePayloadsRepository) {}

  /** Redact live sensitive payloads older than the retention window for this tenant. */
  sweep(tenantId: string): Promise<{ redacted: number }> {
    return this.payloads.sweep(tenantId);
  }
}
