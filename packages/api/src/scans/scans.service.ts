import { ForbiddenException, Injectable } from '@nestjs/common';
import type { ScanAck, SubmitScanInput } from '@clearview/shared';
import { RealtimeService } from '../objects/realtime.service';
import { ScansRepository, NoStaffIdentityError } from './scans.repository';
import type { SessionIdentity } from '../auth/session.types';

/**
 * T-05 · patient-scan service. Thin orchestration over the repository (atomic RLS-scoped write).
 * After a scan commits, publish a broadcast-only SSE nudge so the manager board can refetch — the
 * wire carries NO business logic and NO verdict (原则: SSE 只播报; a scan is neutral).
 */
@Injectable()
export class ScansService {
  constructor(
    private readonly repo: ScansRepository,
    private readonly realtime: RealtimeService,
  ) {}

  async submit(
    tenantId: string,
    identity: SessionIdentity | undefined,
    input: SubmitScanInput,
  ): Promise<ScanAck> {
    let ack: ScanAck;
    try {
      ack = await this.repo.submitScan(tenantId, identity, input);
    } catch (err) {
      if (err instanceof NoStaffIdentityError) {
        throw new ForbiddenException('no staff identity for the caller');
      }
      throw err;
    }
    // Broadcast-only nudge. Target the resolved Visit when known, else the scanning employee.
    this.realtime.publish({
      kind: 'updated',
      tenantId,
      objectId: ack.patientVisitId ?? ack.employeeId,
      type: ack.patientVisitId ? 'Visit' : 'Staff',
      at: new Date().toISOString(),
    });
    return ack;
  }
}
