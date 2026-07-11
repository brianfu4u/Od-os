import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { EventsModule } from './events/events.module';
import { ObjectsModule } from './objects/objects.module';
import { ReportsModule } from './reports/reports.module';
import { UploadsModule } from './uploads/uploads.module';
import { VerificationModule } from './verification/verification.module';
import { RecommendationModule } from './recommendations/recommendation.module';
import { OverviewModule } from './overview/overview.module';
import { LearningModule } from './learning/learning.module';
import { ListenerModule } from './listener/listener.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { TasksModule } from './tasks/tasks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventsModule,
    DatabaseModule,
    AuthModule,
    ObjectsModule,
    ReportsModule,
    UploadsModule,
    LearningModule,
    VerificationModule,
    RecommendationModule,
    OverviewModule,
    ListenerModule,
    TranscriptionModule,
    TasksModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
