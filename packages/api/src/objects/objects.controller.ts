import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { type Observable, map } from 'rxjs';
import type { CreateObjectInput, UpdateObjectInput, ObjectChangeEvent } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { ObjectsService } from './objects.service';
import { RealtimeService } from './realtime.service';

@UseGuards(TenantGuard)
@Controller('objects')
export class ObjectsController {
  constructor(
    private readonly objects: ObjectsService,
    private readonly realtime: RealtimeService,
  ) {}

  @Post()
  create(@TenantId() tenantId: string, @Body() body: CreateObjectInput) {
    return this.objects.create(tenantId, body);
  }

  @Get()
  list(
    @TenantId() tenantId: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.objects.list(tenantId, {
      type,
      limit: limit !== undefined ? Number(limit) : undefined,
      offset: offset !== undefined ? Number(offset) : undefined,
      includeArchived: includeArchived === 'true',
    });
  }

  // NOTE: declared before ':id' so GET /objects/stream is not captured as an id.
  @Sse('stream')
  stream(@TenantId() tenantId: string): Observable<{ data: ObjectChangeEvent }> {
    return this.realtime.forTenant(tenantId).pipe(map((event) => ({ data: event })));
  }

  @Get(':id')
  get(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.objects.get(tenantId, id);
  }

  @Patch(':id')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: UpdateObjectInput) {
    return this.objects.update(tenantId, id, body);
  }

  @Delete(':id')
  async remove(@TenantId() tenantId: string, @Param('id') id: string) {
    await this.objects.remove(tenantId, id);
    return { ok: true };
  }
}
