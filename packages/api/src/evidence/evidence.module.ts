import { Module } from '@nestjs/common';
import { createStorageProvider } from '../storage/storage.factory';
import { STORAGE_PORT } from '../storage/storage.provider';
import { EvidenceController } from './evidence.controller';
import { EventLogRepository } from './event-log.repository';
import { PhotoEvidenceService } from './photo-evidence.service';

@Module({
  controllers: [EvidenceController],
  providers: [
    PhotoEvidenceService,
    EventLogRepository,
    // Reuse the P0-3 StoragePort selection; T-16 adds no storage backend or configuration path.
    { provide: STORAGE_PORT, useFactory: createStorageProvider },
  ],
})
export class EvidenceModule {}
