import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { ObjectsModule } from './objects/objects.module';
import { ReportsModule } from './reports/reports.module';
import { UploadsModule } from './uploads/uploads.module';
import { VerificationModule } from './verification/verification.module';
import { RecommendationModule } from './recommendations/recommendation.module';
import { OverviewModule } from './overview/overview.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventsModule,
    DatabaseModule,
    ObjectsModule,
    ReportsModule,
    UploadsModule,
    VerificationModule,
    RecommendationModule,
    OverviewModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
