import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { VerificationModule } from '../verification/verification.module';
import { TranscriptionModule } from '../transcription/transcription.module';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { UploadsRepository } from './uploads.repository';
import { STORAGE_PORT } from '../storage/storage.provider';
import { createStorageProvider } from '../storage/storage.factory';

@Module({
  // RealtimeService + VERIFICATION_HOOK + TRANSCRIPTION_HOOK (P7/T4 async STT trigger).
  imports: [ObjectsModule, VerificationModule, TranscriptionModule],
  controllers: [UploadsController],
  providers: [
    UploadsService,
    UploadsRepository,
    // useFactory (not useClass): the provider's constructor takes an optional param it resolves from
    // env itself; the factory sidesteps DI introspection and selects local vs s3 via STORAGE_DRIVER.
    { provide: STORAGE_PORT, useFactory: createStorageProvider },
  ],
})
export class UploadsModule {}
