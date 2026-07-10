import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { ActionsModule } from '../actions/actions.module';
import { LearningModule } from '../learning/learning.module';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';
import { RecommendationRepository } from './recommendation.repository';

@Module({
  // RealtimeService + ActionExecutor + LearningRepository (DomainEventBus is provided globally).
  imports: [ObjectsModule, ActionsModule, LearningModule],
  controllers: [RecommendationController],
  providers: [RecommendationService, RecommendationRepository],
  exports: [RecommendationService],
})
export class RecommendationModule {}
