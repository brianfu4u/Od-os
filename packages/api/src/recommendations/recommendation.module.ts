import { Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';
import { RecommendationRepository } from './recommendation.repository';

@Module({
  imports: [ObjectsModule], // RealtimeService (DomainEventBus is provided globally by EventsModule)
  controllers: [RecommendationController],
  providers: [RecommendationService, RecommendationRepository],
})
export class RecommendationModule {}
