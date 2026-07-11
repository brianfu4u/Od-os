/**
 * Keyless fallback Transcriber. When no STT provider is configured (no STT_API_KEY), we must NOT
 * invent text — so this adapter returns `unavailable` for every clip. The service records the
 * attempt, keeps the original audio untouched, and the transcription is retryable once a key is set
 * (mirrors how LLM1 degrades to its heuristic when DEEPSEEK_API_KEY is absent — except STT cannot
 * meaningfully guess speech, so it declines rather than fabricates).
 */
import type { TranscribeInput, TranscriptionResult, Transcriber } from './transcription.types';

export class NullTranscriber implements Transcriber {
  readonly name = 'null';

  async transcribe(_input: TranscribeInput): Promise<TranscriptionResult> {
    return {
      status: 'unavailable',
      text: null,
      language: null,
      confidence: null,
      provider: this.name,
      model: null,
      error: 'no STT provider configured (set STT_PROVIDER + STT_API_KEY)',
    };
  }
}
