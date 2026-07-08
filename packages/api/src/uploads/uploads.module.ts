import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { VerificationModule } from '../verification/verification.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { UploadsRepository } from './uploads.repository';
import { STORAGE_PORT } from '../storage/storage.provider';
import { LocalDiskStorageProvider } from '../storage/local-disk.provider';

@Module({
  imports: [ObjectsModule, VerificationModule], // RealtimeService + VERIFICATION_HOOK
  controllers: [UploadsController],
  providers: [
    UploadsService,
    UploadsRepository,
    // useFactory (not useClass): the provider's constructor takes an optional `baseDir?: string`
    // it resolves from UPLOAD_DIR itself. useClass would make Nest try to inject that `String`
    // param and fail to boot; the factory sidesteps DI introspection of the constructor.
    { provide: STORAGE_PORT, useFactory: () => new LocalDiskStorageProvider() },
  ],
})
export class UploadsModule {}
