import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { ReportsRepository } from './reports.repository';

@Module({
  imports: [ObjectsModule], // for RealtimeService
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository],
})
export class ReportsModule {}
