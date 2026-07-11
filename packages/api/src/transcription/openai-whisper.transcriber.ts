/**
 * OpenAI Whisper adapter — the first real Transcriber. Whisper's transcription endpoint is
 * `POST {baseUrl}/audio/transcriptions` (multipart/form-data) with model `whisper-1` and
 * `response_format=verbose_json` (so we get the detected language + per-segment logprobs).
 *
 * The API key comes from the STT_API_KEY env var (passed in by the module factory) and is NEVER
 * logged or committed. This adapter is intentionally decoupled from LLM1/DeepSeek — STT is a
 * SEPARATE provider with its own key; DEEPSEEK_API_KEY is never read here.
 *
 * Resilience: any transport/parse error is caught and returned as a `failed` result (NOT thrown, and
 * NO text invented) so the service can mark the attempt, keep the original audio, and allow a retry.
 */
import { Logger } from '@nestjs/common';
import type { TranscribeInput, TranscriptionResult, Transcriber } from './transcription.types';

interface WhisperSegment {
  avg_logprob?: number;
  no_speech_prob?: number;
}
interface WhisperVerboseResponse {
  text?: string;
  language?: string;
  segments?: WhisperSegment[];
}

/** Map an audio MIME type to a filename extension Whisper accepts. */
function extForMime(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('x-m4a')) return 'm4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('aac')) return 'aac';
  if (m.includes('amr')) return 'amr';
  if (m.includes('wav')) return 'wav';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('webm')) return 'webm';
  if (m.includes('flac')) return 'flac';
  return 'm4a';
}

/** Derive a coarse [0,1] confidence from Whisper's per-segment avg_logprob (natural log). */
function confidenceFromSegments(segments: WhisperSegment[] | undefined): number | null {
  if (!segments || segments.length === 0) return null;
  const lps = segments.map((s) => (typeof s.avg_logprob === 'number' ? s.avg_logprob : null)).filter((n): n is number => n !== null);
  if (lps.length === 0) return null;
  const meanLogprob = lps.reduce((a, b) => a + b, 0) / lps.length;
  // exp(avg_logprob) ∈ (0,1]; blend down when segments look like non-speech.
  const noSpeech = segments.map((s) => (typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0));
  const meanNoSpeech = noSpeech.reduce((a, b) => a + b, 0) / noSpeech.length;
  const conf = Math.exp(meanLogprob) * (1 - Math.min(Math.max(meanNoSpeech, 0), 1));
  return Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null;
}

export class OpenAiWhisperTranscriber implements Transcriber {
  readonly name = 'openai';
  private readonly logger = new Logger(OpenAiWhisperTranscriber.name);

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.STT_BASE_URL || 'https://api.openai.com/v1',
    private readonly model = process.env.STT_MODEL || 'whisper-1',
    private readonly timeoutMs = Number(process.env.STT_TIMEOUT_MS || 30000),
  ) {}

  async transcribe(input: TranscribeInput): Promise<TranscriptionResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      const blob = new Blob([input.bytes], { type: input.mime || 'application/octet-stream' });
      form.append('file', blob, `audio.${extForMime(input.mime)}`);
      form.append('model', this.model);
      form.append('response_format', 'verbose_json');
      if (input.languageHint) form.append('language', input.languageHint);

      const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` }, // do NOT set Content-Type; fetch sets the multipart boundary
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json()) as WhisperVerboseResponse;
      const text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text) {
        return { status: 'failed', text: null, language: data.language ?? null, confidence: null, provider: this.name, model: this.model, error: 'empty transcript' };
      }
      return {
        status: 'done',
        text,
        language: typeof data.language === 'string' ? data.language : null,
        confidence: confidenceFromSegments(data.segments),
        provider: this.name,
        model: this.model,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Whisper transcription failed (retryable): ${message}`);
      return { status: 'failed', text: null, language: null, confidence: null, provider: this.name, model: this.model, error: message };
    } finally {
      clearTimeout(timer);
    }
  }
}
