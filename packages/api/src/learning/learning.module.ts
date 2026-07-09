import { Module } from '@nestjs/common';
import { LearningController } from './learning.controller';
import { LearningService } from './learning.service';
import { LearningRepository } from './learning.repository';

/** P4/S8 learning loop. Exports the repository so S3 (RecommendationService) can read penalties. */
@Module({
  controllers: [LearningController],
  providers: [LearningService, LearningRepository],
  exports: [LearningRepository, LearningService],
})
export class LearningModule {}
