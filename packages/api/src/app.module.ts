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
import { OpsModule } from './ops/ops.module';
import { AssignmentsModule } from './assignments/assignment.module';
import { EmployeeStatusModule } from './employee-status/employee-status.module';
import { ScansModule } from './scans/scans.module';
import { AttentionModule } from './attention/attention.module';
import { RetentionModule } from './retention/retention.module';
import { EvidenceModule } from './evidence/evidence.module';

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
    OpsModule,
    AssignmentsModule,
    EmployeeStatusModule,
    ScansModule,
    AttentionModule,
    RetentionModule,
    EvidenceModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
