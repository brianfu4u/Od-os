import { BadRequestException, Injectable } from '@nestjs/common';
import type { StaffReportInput, StaffReportResult } from '@clearview/shared';
import { ReportsRepository } from './reports.repository';
import { RealtimeService } from '../objects/realtime.service';
import { validateReportInput } from './reports.validation';

@Injectable()
export class ReportsService {
  constructor(
    private readonly repo: ReportsRepository,
    private readonly realtime: RealtimeService,
  ) {}

  async ingest(tenantId: string, input: StaffReportInput): Promise<StaffReportResult> {
    const error = validateReportInput(input);
    if (error) throw new BadRequestException(error);

    const result = await this.repo.ingest(tenantId, input);
    if (!result.deduped) {
      this.realtime.publish({
        kind: 'created',
        tenantId,
        objectId: result.communicationId,
        type: 'Communication',
        at: new Date().toISOString(),
      });
    }
    return result;
  }
}
