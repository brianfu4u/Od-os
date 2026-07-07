import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { UploadsRepository } from './uploads.repository';
import { STORAGE_PORT } from '../storage/storage.provider';
import { LocalDiskStorageProvider } from '../storage/local-disk.provider';

@Module({
  imports: [ObjectsModule], // for RealtimeService
  controllers: [UploadsController],
  providers: [
    UploadsService,
    UploadsRepository,
    { provide: STORAGE_PORT, useClass: LocalDiskStorageProvider },
  ],
})
export class UploadsModule {}
