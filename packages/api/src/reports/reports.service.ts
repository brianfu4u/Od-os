import { BadRequestException, Inject, Injectable, Optional } from '@nestjs/common';
import type { StaffReportInput, StaffReportResult } from '@clearview/shared';
import { ReportsRepository } from './reports.repository';
import { RealtimeService } from '../objects/realtime.service';
import { DomainEventBus } from '../events/domain-event-bus';
import { VERIFICATION_HOOK, type VerificationHook } from '../verification/verification.hook';
import { validateReportInput } from './reports.validation';
import type { SessionIdentity } from '../auth/session.types';

@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly realtime: RealtimeService,
    @Optional() @Inject(VERIFICATION_HOOK) private readonly verification?: VerificationHook,
    @Optional() private readonly bus?: DomainEventBus,
  ) {}

  async ingest(tenantId: string, input: StaffReportInput, identity: SessionIdentity): Promise<StaffReportResult> {
    const error = validateReportInput(input);
    if (error) throw new BadRequestException(error);

    const result = await this.repo.ingest(tenantId, input, identity);
    if (!result.deduped) {
      this.realtime.publish({
        kind: 'created',
        tenantId,
        objectId: result.communicationId,
        type: 'Communication',
        at: new Date().toISOString(),
      });
      // Event-driven re-score: scans/attachments are evidence → re-verify their targets (S2).
      if (this.verification) {
        const targets = new Set<string>();
        for (const s of input.scans ?? []) if (s.scannedObjectId) targets.add(s.scannedObjectId);
        for (const a of input.attachments ?? []) if (a.objectId) targets.add(a.objectId);
        for (const id of targets) {
          try {
            await this.verification.verifyObject(tenantId, id);
          } catch {
            /* best-effort re-verification */
          }
        }
      }
      // LLM1 «Listen» layer: fan the committed report onto the domain event bus for async semantic
      // analysis (classify + extract claim + suggest). The listener schedules work and returns
      // immediately, so report ingestion is never blocked by an LLM call.
      await this.bus?.publish({
        type: 'report.received',
        tenantId,
        objectId: result.communicationId,
        payload: { reportType: input.reportType },
      });
    }
    return result;
  }
}
