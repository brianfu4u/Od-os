import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';
import { VerificationRepository } from './verification.repository';
import { DeterministicScorer, SCORER } from './scorer';
import { VERIFICATION_HOOK } from './verification.hook';

@Module({
  imports: [ObjectsModule], // for RealtimeService
  controllers: [VerificationController],
  providers: [
    VerificationService,
    VerificationRepository,
    { provide: SCORER, useClass: DeterministicScorer },
    { provide: VERIFICATION_HOOK, useExisting: VerificationService },
  ],
  exports: [VerificationService, VERIFICATION_HOOK],
})
export class VerificationModule {}
