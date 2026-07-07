import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import type { CreateLinkInput } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { ObjectsService } from './objects.service';

@UseGuards(TenantGuard)
@Controller('links')
export class LinksController {
  constructor(private readonly objects: ObjectsService) {}

  @Post()
  create(@TenantId() tenantId: string, @Body() body: CreateLinkInput) {
    return this.objects.createLink(tenantId, body);
  }
}
