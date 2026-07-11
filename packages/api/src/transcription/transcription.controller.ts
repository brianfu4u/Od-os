import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { TranscriptionService, type TranscriptionOutcome } from './transcription.service';

/**
 * Manual retry for a voice transcription (ops / demo). Transcription is normally triggered
 * automatically and asynchronously right after a voice upload commits; this RLS-checked endpoint
 * lets an authorized caller re-run it for their own object (e.g. after a provider outage or once the
 * STT_API_KEY is configured). `force` re-does even a previously completed transcript.
 */
@Controller('transcription')
export class TranscriptionController {
  constructor(private readonly transcription: TranscriptionService) {}

  @Post(':id/retry')
  @UseGuards(TenantGuard)
  async retry(@TenantId() tenantId: string, @Param('id') id: string): Promise<{ objectId: string; status: TranscriptionOutcome }> {
    const status = await this.transcription.transcribe(tenantId, id, { force: true });
    return { objectId: id, status };
  }
}
