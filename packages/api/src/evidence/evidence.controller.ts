import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { PhotoEvidenceReceipt } from '@clearview/shared';
import type { SessionIdentity } from '../auth/session.types';
import { AuthIdentity, TenantId } from '../tenant/tenant.decorator';
import { Roles } from '../tenant/roles.decorator';
import { RolesGuard } from '../tenant/roles.guard';
import { TenantGuard } from '../tenant/tenant.guard';
import { PhotoEvidenceService } from './photo-evidence.service';
import type { PhotoFileInput, RawPhotoMetadata } from './photo-evidence.validation';

/**
 * T-16 neutral photo intake. STAFF-AND-ABOVE; tenant, store, and actor hints are session-derived.
 * This endpoint only acknowledges that bytes arrived. It never verifies an action or invokes an LLM.
 */
@UseGuards(TenantGuard, RolesGuard)
@Roles('staff')
@Controller('evidence')
export class EvidenceController {
  constructor(private readonly photos: PhotoEvidenceService) {}

  @Post('photo')
  @UseInterceptors(FileInterceptor('file', { limits: { files: 1, fileSize: 10 * 1024 * 1024 } }))
  receivePhoto(
    @TenantId() tenantId: string,
    @AuthIdentity() identity: SessionIdentity,
    @UploadedFile() file: PhotoFileInput | undefined,
    @Body() body: RawPhotoMetadata | undefined,
  ): Promise<PhotoEvidenceReceipt> {
    if (!file) throw new BadRequestException('multipart field "file" is required');
    return this.photos.receive(tenantId, identity, file, body);
  }
}
