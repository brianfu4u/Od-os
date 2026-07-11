import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { VoiceFeedRecord } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { TranscriptionService, type TranscriptionOutcome } from './transcription.service';

/**
 * Voice-transcript endpoints for the command center (P7/T4). Both are tenant-guarded and the STT
 * key stays server-side.
 *  - GET  /transcription/feed        → read-only, RLS-scoped voice transcripts + verdicts.
 *  - POST /transcription/:id/retry   → re-run STT for a voice object (failed/unavailable retry).
 */
@Controller('transcription')
export class TranscriptionController {
  constructor(private readonly transcription: TranscriptionService) {}

  /** Scoped feed so the client no longer pulls every Document + Task to render the voice panel. */
  @Get('feed')
  @UseGuards(TenantGuard)
  feed(@TenantId() tenantId: string, @Query('limit') limit?: string): Promise<VoiceFeedRecord[]> {
    const n = limit ? Number(limit) : undefined;
    return this.transcription.feed(tenantId, n !== undefined && Number.isFinite(n) ? n : undefined);
  }

  /**
   * Manual retry for a voice transcription (ops / demo). Transcription is normally triggered
   * automatically and asynchronously right after a voice upload commits; this RLS-checked endpoint
   * lets an authorized caller re-run it for their own object (e.g. after a provider outage or once
   * the STT_API_KEY is configured). `force` re-does even a previously completed transcript.
   */
  @Post(':id/retry')
  @UseGuards(TenantGuard)
  async retry(@TenantId() tenantId: string, @Param('id') id: string): Promise<{ objectId: string; status: TranscriptionOutcome }> {
    const status = await this.transcription.transcribe(tenantId, id, { force: true });
    return { objectId: id, status };
  }
}
