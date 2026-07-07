import { Module } from '@nestjs/common';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { UploadsRepository } from './uploads.repository';
import { STORAGE_PROVIDER } from '../storage/storage.provider';
import { LocalDiskStorageProvider } from '../storage/local-disk.provider';

@Module({
  controllers: [UploadsController],
  providers: [
    UploadsService,
    UploadsRepository,
    { provide: STORAGE_PROVIDER, useClass: LocalDiskStorageProvider },
  ],
})
export class UploadsModule {}
