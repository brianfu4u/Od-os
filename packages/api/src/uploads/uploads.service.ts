import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { UploadResult } from '@clearview/shared';
import { STORAGE_PROVIDER, type StorageProvider } from '../storage/storage.provider';
import { UploadsRepository } from './uploads.repository';
import { detectKind, validateUpload } from './uploads.validation';

/** Minimal shape of a multer file (avoids an @types/multer dependency). */
export interface UploadFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class UploadsService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly repo: UploadsRepository,
  ) {}

  async upload(
    tenantId: string,
    file: UploadFileInput,
    opts: { kind?: string; linkTo?: string } = {},
  ): Promise<UploadResult> {
    const error = validateUpload(file?.mimetype, file?.size);
    if (error) throw new BadRequestException(error);

    const kind =
      opts.kind === 'Snapshot' || opts.kind === 'Document' ? opts.kind : detectKind(file.mimetype);

    const key = randomUUID();
    const { storageRef } = await this.storage.put({
      tenantId,
      key,
      filename: file.originalname,
      contentType: file.mimetype,
      bytes: file.buffer,
    });

    const properties = {
      storageRef,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      kind,
      uploadedAt: new Date().toISOString(),
    };
    const { id } = await this.repo.createEvidence(tenantId, { kind, properties, linkTo: opts.linkTo });

    return {
      objectId: id,
      kind,
      storageRef,
      url: `/uploads/${id}/content`,
      mimeType: file.mimetype,
      size: file.size,
      filename: file.originalname,
    };
  }
}
