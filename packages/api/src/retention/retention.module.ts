import { Module } from '@nestjs/common';
import { RetentionController } from './retention.controller';
import { RetentionService } from './retention.service';
import { SensitivePayloadsRepository } from './sensitive-payloads.repository';

/**
 * P1-6-b retention module. Owns the sensitive-payloads side-store write/redact helper and the
 * manager-triggered retention sweep endpoint. Exports SensitivePayloadsRepository so the write
 * paths (listener, scans) can mirror raw content into the side-store at write time (population).
 */
@Module({
  controllers: [RetentionController],
  providers: [RetentionService, SensitivePayloadsRepository],
  exports: [SensitivePayloadsRepository],
})
export class RetentionModule {}
