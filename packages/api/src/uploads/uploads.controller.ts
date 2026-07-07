import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { SignedUrlResult } from '@clearview/shared';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantId } from '../tenant/tenant.decorator';
import { UploadsService, type UploadFileInput } from './uploads.service';
import { UploadsRepository } from './uploads.repository';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.provider';
import { verifyContentSig } from '../storage/url-signing';

/** Minimal response shape we use (avoids an express type dependency). */
interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  send(body: unknown): void;
}

@Controller('uploads')
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly repo: UploadsRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  @Post()
  @UseGuards(TenantGuard)
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @TenantId() tenantId: string,
    @UploadedFile() file: UploadFileInput | undefined,
    @Body() body: { kind?: string; linkTo?: string; relation?: string },
  ) {
    if (!file) throw new BadRequestException('multipart field "file" is required');
    return this.uploads.upload(tenantId, file, {
      kind: body?.kind,
      linkTo: body?.linkTo,
      relation: body?.relation,
    });
  }

  /** Signed content route — authorized by the HMAC signature, so NO tenant guard here. */
  @Get('content')
  async content(
    @Query('key') key: string,
    @Query('ct') ct: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Res() res: HttpResponse,
  ): Promise<void> {
    if (!verifyContentSig(key, ct, Number(exp), sig)) {
      res.status(403).send('invalid or expired signature');
      return;
    }
    const bytes = await this.storage.read(key);
    res.setHeader('Content-Type', ct);
    res.send(bytes);
  }

  /** RLS-checked: mints a short-lived signed download URL for the caller's own object. */
  @Get(':id/url')
  @UseGuards(TenantGuard)
  async signedUrl(@TenantId() tenantId: string, @Param('id') id: string): Promise<SignedUrlResult> {
    const meta = await this.repo.getStoredMeta(tenantId, id);
    if (!meta) throw new NotFoundException('file not found');
    return this.storage.getSignedUrl(meta.storageKey, meta.mime);
  }
}
