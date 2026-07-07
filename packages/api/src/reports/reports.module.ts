import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { VerificationModule } from '../verification/verification.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsRepository } from './reports.repository';

@Module({
  imports: [ObjectsModule, VerificationModule], // RealtimeService + VERIFICATION_HOOK
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository],
})
export class ReportsModule {}
