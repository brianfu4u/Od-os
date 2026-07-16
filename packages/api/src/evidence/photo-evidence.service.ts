import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PhotoEvidenceReceipt } from '@clearview/shared';
import type { SessionIdentity } from '../auth/session.types';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.provider';
import { stripImageMetadata } from '../uploads/image-metadata';
import { EventLogRepository } from './event-log.repository';
import {
  parsePhotoMetadata,
  sourceTypeFor,
  subjectHintsFor,
  validatePhotoFile,
  type PhotoFileInput,
  type RawPhotoMetadata,
} from './photo-evidence.validation';

@Injectable()
export class PhotoEvidenceService {
  private readonly logger = new Logger(PhotoEvidenceService.name);

  constructor(
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly eventLog: EventLogRepository,
  ) {}

  async receive(
    tenantId: string,
    identity: SessionIdentity,
    file: PhotoFileInput,
    rawMetadata: RawPhotoMetadata = {},
  ): Promise<PhotoEvidenceReceipt> {
    const fileError = validatePhotoFile(file);
    if (fileError) throw new BadRequestException(fileError);
    const parsed = parsePhotoMetadata(rawMetadata);
    if (parsed.error || !parsed.value)
      throw new BadRequestException(parsed.error ?? 'invalid photo metadata');

    // The embedded camera already emits a fresh JPEG without EXIF. Strip again at the trust boundary
    // so direct API clients cannot persist GPS/EXIF metadata either. Hash exactly the stored bytes.
    const bytes = stripImageMetadata('image/jpeg', file.buffer);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const storageKey = `tenant/${tenantId}/event-log/${randomUUID()}.jpg`;
    await this.storage.put({ storageKey, contentType: 'image/jpeg', bytes });

    try {
      const event = await this.eventLog.appendPhoto(tenantId, {
        terminalId: parsed.value.terminalId,
        sourceType: sourceTypeFor(identity),
        seq: parsed.value.seq,
        occurredAt: parsed.value.occurredAt,
        subjectHints: subjectHintsFor(identity),
        payload: { storageKey, sha256, mime: 'image/jpeg', size: bytes.length },
      });
      return { ...event, sha256, size: bytes.length };
    } catch (error) {
      // Storage cannot participate in the DB transaction. Compensate a failed immutable-ledger
      // insert so the shortest path cannot leave an unreferenced clinic photo behind.
      try {
        await this.storage.delete(storageKey);
      } catch (cleanupError) {
        this.logger.error(`failed to remove orphaned photo ${storageKey}`, cleanupError);
      }
      throw error;
    }
  }
}
