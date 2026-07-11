import { Logger, Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { ListenerModule } from '../listener/listener.module';
import { STORAGE_PORT } from '../storage/storage.provider';
import { LocalDiskStorageProvider } from '../storage/local-disk.provider';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionService } from './transcription.service';
import { TranscriptionRepository } from './transcription.repository';
import { OpenAiWhisperTranscriber } from './openai-whisper.transcriber';
import { MockTranscriber } from './mock.transcriber';
import { NullTranscriber } from './null.transcriber';
import { TRANSCRIBER, type Transcriber } from './transcription.types';
import { TRANSCRIPTION_HOOK } from './transcription.hook';

/**
 * Select the STT adapter at boot from provider-neutral env (STT_PROVIDER + STT_API_KEY):
 *   - openai (default when a key is present): OpenAI Whisper.
 *   - mock: the deterministic MockTranscriber (explicit local/demo opt-in only).
 *   - anything else, or no key: NullTranscriber — which DECLINES (marks unavailable) rather than
 *     fabricating text, so a keyless dev/CI env is safe and a future tencent/aliyun provider can be
 *     added here without changing callers.
 * The key is read from the environment only and is NEVER logged. STT is independent of DeepSeek.
 */
export function makeTranscriber(): Transcriber {
  const provider = (process.env.STT_PROVIDER || '').toLowerCase();
  const key = process.env.STT_API_KEY;
  let adapter: Transcriber;
  if (provider === 'mock') {
    adapter = new MockTranscriber();
  } else if ((provider === 'openai' || provider === '') && key) {
    adapter = new OpenAiWhisperTranscriber(key);
  } else {
    adapter = new NullTranscriber();
  }
  new Logger('TranscriptionModule').log(`STT adapter selected: ${adapter.name}`);
  return adapter;
}

@Module({
  imports: [ObjectsModule, ListenerModule], // ObjectsService + LlmListenerService
  controllers: [TranscriptionController],
  providers: [
    TranscriptionService,
    TranscriptionRepository,
    { provide: TRANSCRIBER, useFactory: makeTranscriber },
    // Own storage handle (same LocalDiskStorageProvider / UPLOAD_DIR as uploads) to read audio bytes.
    { provide: STORAGE_PORT, useFactory: () => new LocalDiskStorageProvider() },
    // The uploads module fires STT through this token (fire-and-forget) — same instance as the service.
    { provide: TRANSCRIPTION_HOOK, useExisting: TranscriptionService },
  ],
  exports: [TRANSCRIPTION_HOOK],
})
export class TranscriptionModule {}
