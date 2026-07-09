import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { ActionsModule } from '../actions/actions.module';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';
import { RecommendationRepository } from './recommendation.repository';

@Module({
  imports: [ObjectsModule, ActionsModule], // RealtimeService + ActionExecutor (DomainEventBus is global)
  controllers: [RecommendationController],
  providers: [RecommendationService, RecommendationRepository],
})
export class RecommendationModule {}
