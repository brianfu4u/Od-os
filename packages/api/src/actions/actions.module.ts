import { Module } from '@nestjs/common';
import { ActionExecutor } from './action-executor';

/** Provides the action write-back executor (P2 · S4). Imported by RecommendationModule. */
@Module({
  providers: [ActionExecutor],
  exports: [ActionExecutor],
})
export class ActionsModule {}
