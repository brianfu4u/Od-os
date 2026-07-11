/**
 * P7 · T4 Speech-to-Text (STT). The pluggable transcription seam.
 *
 * A `Transcriber` turns an uploaded voice clip into text. It is provider-neutral by design:
 *  - dev/CI: OpenAI Whisper (OpenAiWhisperTranscriber) or the deterministic MockTranscriber (tests),
 *  - keyless: NullTranscriber (marks the attempt `unavailable` — it NEVER fabricates text),
 *  - production (China clinics): a Tencent Cloud / Aliyun ASR adapter can be dropped in later behind
 *    the SAME interface (in-country, compliant, low latency) with no change to callers.
 *
 * ⛔ MOAT: a Transcriber produces ONLY derived text + metadata. It never touches the state triplet.
 * The transcript is stored as a derived field on the source voice Document and fed to LLM1 as a
 * CLAIM source; the deterministic cross-verification engine (S2) alone owns `verified_state`.
 *
 * Credentials come from environment variables only (STT_API_KEY) and are NEVER logged or committed.
 * STT is entirely independent of the LLM1/DeepSeek key — do NOT reuse DEEPSEEK_API_KEY here.
 */

/** DI token for the active Transcriber implementation. */
export const TRANSCRIBER = 'TRANSCRIBER';

/** Outcome of one transcription attempt. */
export type TranscriptionStatus =
  | 'done' // transcript produced with acceptable confidence → fed to LLM1
  | 'low_confidence' // transcript produced but below threshold → marked, NOT fed to LLM1
  | 'failed' // provider/transport error → NO text fabricated; retryable (audio retained)
  | 'unavailable'; // no STT provider configured (keyless) → NO text fabricated; retryable

export interface TranscribeInput {
  /** Raw audio bytes (amr / m4a / aac / wav / mp3 …). */
  bytes: Buffer;
  /** MIME type of the audio, from the stored Document. */
  mime: string;
  /** Preferred language (BCP-47-ish: 'zh' | 'en' | 'ja' | …). Provider may auto-detect if omitted. */
  languageHint?: string | null;
}

export interface TranscriptionResult {
  status: TranscriptionStatus;
  /** The transcript, or null when status is failed/unavailable (we NEVER invent text). */
  text: string | null;
  /** Detected language, when the provider reports it. */
  language: string | null;
  /** Confidence in [0,1], or null when the provider gives none. */
  confidence: number | null;
  /** Adapter name that produced this result ('openai' | 'mock' | 'null' | …). */
  provider: string;
  /** Model identifier, e.g. 'whisper-1' (null for the keyless adapter). */
  model: string | null;
  /** Human-readable reason when status='failed' (never contains secrets). */
  error?: string | null;
}

/**
 * Pluggable transcriber. Implementations MUST be side-effect free (no DB / no state writes) and MUST
 * NOT throw for provider/transport errors — they return a `failed` result so the service can mark the
 * attempt and keep the original audio. Applying the transcript + audit is the SERVICE's job, so the
 * moat and persistence stay enforced in one place.
 */
export interface Transcriber {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<TranscriptionResult>;
}
