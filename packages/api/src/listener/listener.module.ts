import { Logger, Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { RecommendationModule } from '../recommendations/recommendation.module';
import { ListenerController } from './listener.controller';
import { LlmListenerService } from './listener.service';
import { LlmListenerRepository } from './listener.repository';
import { HeuristicListener } from './heuristic-listener';
import { DeepSeekListener } from './deepseek-listener';
import { LLM_LISTENER, type LlmListenerPort } from './listener.types';

/**
 * Select the active adapter at boot. DeepSeek when DEEPSEEK_API_KEY is set (unless explicitly
 * pinned to heuristic via LLM_LISTENER=heuristic); otherwise the deterministic HeuristicListener —
 * so the layer runs keyless in dev/CI/tests and degrades gracefully when DeepSeek is unavailable.
 * The API key is read from the environment only and never logged.
 */
export function makeListener(): LlmListenerPort {
  const heuristic = new HeuristicListener();
  const key = process.env.DEEPSEEK_API_KEY;
  const adapter = key && process.env.LLM_LISTENER !== 'heuristic' ? new DeepSeekListener(key, heuristic) : heuristic;
  new Logger('ListenerModule').log(`listen adapter selected: ${adapter.name}`);
  return adapter;
}

@Module({
  imports: [ObjectsModule, RecommendationModule],
  controllers: [ListenerController],
  providers: [LlmListenerService, LlmListenerRepository, { provide: LLM_LISTENER, useFactory: makeListener }],
  // Exported so P7/T4 (TranscriptionModule) can feed voice transcripts through the same LLM1 path.
  exports: [LlmListenerService],
})
export class ListenerModule {}
