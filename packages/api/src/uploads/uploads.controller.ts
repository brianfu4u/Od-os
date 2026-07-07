import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { UploadsService, type UploadFileInput } from './uploads.service';
import { UploadsRepository } from './uploads.repository';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/storage.provider';

/** Minimal response shape we use (avoids an express type dependency). */
interface HttpResponse {
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

@UseGuards(TenantGuard)
@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly repo: UploadsRepository,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @TenantId() tenantId: string,
    @UploadedFile() file: UploadFileInput | undefined,
    @Body() body: { kind?: string; linkTo?: string },
  ) {
    if (!file) throw new BadRequestException('multipart field "file" is required');
    return this.uploads.upload(tenantId, file, { kind: body?.kind, linkTo: body?.linkTo });
  }

  @Get(':id/content')
  async content(
    @TenantId() tenantId: string,
    @Param('id') id: string,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const meta = await this.repo.getStoredMeta(tenantId, id);
    if (!meta) throw new NotFoundException('file not found');
    const bytes = await this.storage.get(meta.storageRef);
    res.setHeader('Content-Type', meta.mimeType);
    res.send(bytes);
  }
}
