import { Logger, Module } from '@nestjs/common';
import { ObjectsModule } from '../objects/objects.module';
import { ListenerModule } from '../listener/listener.module';
import { STORAGE_PORT } from '../storage/storage.provider';
import { createStorageProvider } from '../storage/storage.factory';
import { TranscriptionController } from './transcription.controller';
import { TranscriptionService } from './transcription.service';
import { TranscriptionRepository } from './transcription.repository';
import { OpenAiWhisperTranscriber } from './openai-whisper.transcriber';
import { MockTranscriber } from './mock.transcriber';
import { NullTranscriber } from './null.transcriber';
import { TRANSCRIBER, type Transcriber } from './transcription.types';
import { TRANSCRIPTION_HOOK } from './transcription.hook';
import { resolveExternalProviders } from '../config/security';

/**
 * Select the STT adapter at boot from provider-neutral env (STT_PROVIDER + STT_API_KEY):
 *   - openai (default when a key is present): OpenAI Whisper.
 *   - mock: the deterministic MockTranscriber (explicit local/demo opt-in only).
 *   - anything else, or no key: NullTranscriber — which DECLINES (marks unavailable) rather than
 *     fabricating text, so a keyless dev/CI env is safe and a future tencent/aliyun provider can be
 *     added here without changing callers.
 * The key is read from the environment only and is NEVER logged. STT is independent of DeepSeek.
 *
 * P1-6-c: the compliance downgrade switch (COMPLIANCE_EXTERNAL_PROVIDERS=off) overrides the external
 * path — even with STT_API_KEY present we pin to NullTranscriber (which DECLINES rather than sending
 * audio off-box or fabricating text), so no audio leaves the box. The explicit `mock` opt-in is a
 * local/demo-only deterministic adapter (no external call) and is left untouched.
 */
export function makeTranscriber(): Transcriber {
  const provider = (process.env.STT_PROVIDER || '').toLowerCase();
  const key = process.env.STT_API_KEY;
  const external = resolveExternalProviders();
  let adapter: Transcriber;
  if (provider === 'mock') {
    adapter = new MockTranscriber();
  } else if (external.enabled && (provider === 'openai' || provider === '') && key) {
    adapter = new OpenAiWhisperTranscriber(key);
  } else {
    adapter = new NullTranscriber();
  }
  const log = new Logger('TranscriptionModule');
  if (!external.enabled && provider !== 'mock') {
    log.warn('compliance downgrade: external STT disabled (COMPLIANCE_EXTERNAL_PROVIDERS=off) — pinned to null transcriber');
  }
  log.log(`STT adapter selected: ${adapter.name}`);
  return adapter;
}

@Module({
  imports: [ObjectsModule, ListenerModule], // ObjectsService + LlmListenerService
  controllers: [TranscriptionController],
  providers: [
    TranscriptionService,
    TranscriptionRepository,
    { provide: TRANSCRIBER, useFactory: makeTranscriber },
    // Own storage handle (same STORAGE_DRIVER selection as uploads) to read audio bytes back.
    { provide: STORAGE_PORT, useFactory: createStorageProvider },
    // The uploads module durably enqueues STT through this token — same instance as the service.
    { provide: TRANSCRIPTION_HOOK, useExisting: TranscriptionService },
  ],
  exports: [TRANSCRIPTION_HOOK],
})
export class TranscriptionModule {}
