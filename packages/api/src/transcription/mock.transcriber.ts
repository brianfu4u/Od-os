/**
 * Deterministic Transcriber for tests / CI / local demo. It performs NO network I/O, so the whole
 * voice → transcript → LLM1 → verification loop is exercisable offline and reproducibly (the same
 * role the HeuristicListener plays for LLM1).
 *
 * It is injected explicitly by tests (see transcription.service.spec.ts and the integration script)
 * with a canned result, so no real audio decoding happens. It can also be pinned in a local dev
 * environment via STT_PROVIDER=mock — an EXPLICIT developer opt-in (clearly labelled provider='mock'
 * in the audit log), never a silent default: keyless environments get the NullTranscriber instead.
 */
import type { TranscribeInput, TranscriptionResult, Transcriber } from './transcription.types';

const DEFAULT_TEXT = process.env.STT_MOCK_TEXT || '3号房已为下一位患者备好';

export class MockTranscriber implements Transcriber {
  readonly name = 'mock';

  /**
   * @param canned Fixed result (or per-call factory) to return. Defaults to a benign, clearly
   *   synthetic Chinese sentence so an accidental prod pin is obvious in the transcript + audit.
   */
  constructor(private readonly canned?: TranscriptionResult | ((input: TranscribeInput) => TranscriptionResult)) {}

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    if (typeof this.canned === 'function') return this.canned(input);
    if (this.canned) return this.canned;
    return {
      status: 'done',
      text: DEFAULT_TEXT,
      language: input.languageHint ?? 'zh',
      confidence: 0.9,
      provider: this.name,
      model: 'mock',
    };
  }
}
