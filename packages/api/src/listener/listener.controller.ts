import { BadRequestException, Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { LlmListenerService } from './listener.service';
import type { ListenLocale } from './listener.types';

/**
 * LLM1 read/echo surface. All tenant-scoped (session-derived tenant; never client-supplied).
 *  - GET  /listen/summary   — a per-shift / day / domain summary of what LLM1 heard.
 *  - POST /listen/analyze   — (re)analyze one Communication now; used by the demo/console and smoke.
 *    Note: normal reports are analyzed automatically & asynchronously via the report event stream;
 *    this endpoint is the synchronous, on-demand path.
 */
@UseGuards(TenantGuard)
@Controller('listen')
export class ListenerController {
  constructor(private readonly listen: LlmListenerService) {}

  @Get('summary')
  summary(
    @TenantId() tenantId: string,
    @Query('scope') scope?: string,
    @Query('hours') hours?: string,
    @Query('domain') domain?: string,
    @Query('locale') locale?: string,
  ) {
    return this.listen.summarize(tenantId, {
      scope,
      hours: hours !== undefined ? Number(hours) : undefined,
      domain,
      locale: (locale as ListenLocale) || undefined,
    });
  }

  @Post('analyze')
  analyze(@TenantId() tenantId: string, @Body() body: { communicationId?: string }) {
    if (!body?.communicationId) throw new BadRequestException('communicationId is required');
    return this.listen.process(tenantId, body.communicationId);
  }
}
