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
import { RolesGuard } from '../tenant/roles.guard';
import { Roles } from '../tenant/roles.decorator';
import { TenantId } from '../tenant/tenant.decorator';
import { ObjectsService } from './objects.service';
import { RealtimeService } from './realtime.service';

/**
 * P0-1: the generic object write surface (create / update / archive) is MANAGER-ONLY. A staff
 * caller can read objects but must go through the narrow, purpose-built endpoints (/reports,
 * /uploads, /scans, /tasks/mine) to affect state — those never accept verification fields. Reads
 * (list / get / timeline / stream / resolve) stay open to any authenticated caller. Combined with
 * the DTOs no longer carrying verifiedState/verificationScore and the DB-level guard trigger, this
 * keeps "verified" writable only by the deterministic S2 Verification Service.
 */
@UseGuards(TenantGuard, RolesGuard)
@Controller('objects')
export class ObjectsController {
  constructor(
    private readonly objects: ObjectsService,
    private readonly realtime: RealtimeService,
  ) {}

  @Post()
  @Roles('manager')
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

  /**
   * T2 · scan-to-locate. Resolve a scanned QR/barcode payload to ONE object in this tenant
   * (read-only, RLS-scoped — a code from another tenant resolves to null). Declared before ':id' so
   * GET /objects/resolve is not captured as an id.
   */
  @Get('resolve')
  async resolveScan(@TenantId() tenantId: string, @Query('code') code?: string) {
    const resolved = await this.objects.resolveScan(tenantId, code ?? '');
    return { resolved };
  }

  @Get(':id')
  get(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.objects.get(tenantId, id);
  }

  /** P3 drill-down: an object's full story — current state + events + verification ledger. */
  @Get(':id/timeline')
  timeline(@TenantId() tenantId: string, @Param('id') id: string) {
    return this.objects.timeline(tenantId, id);
  }

  @Patch(':id')
  @Roles('manager')
  update(@TenantId() tenantId: string, @Param('id') id: string, @Body() body: UpdateObjectInput) {
    return this.objects.update(tenantId, id, body);
  }

  @Delete(':id')
  @Roles('manager')
  async remove(@TenantId() tenantId: string, @Param('id') id: string) {
    await this.objects.remove(tenantId, id);
    return { ok: true };
  }
}
