import { metrics } from '../ops/metrics.registry';
import { buildEvidenceExtractionMessages } from './evidence-extraction.prompts';
import {
  EvidenceExtractionError,
  type EvidenceExtractorInputV1,
  type EvidenceExtractorPort,
} from './evidence-extraction.types';

/** T-13A text-only DeepSeek adapter. It has no fallback that can fabricate an extraction. */
export class DeepSeekEvidenceExtractor implements EvidenceExtractorPort {
  readonly name = 'deepseek';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    readonly model = process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    private readonly timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 12000),
  ) {}

  async extract(input: EvidenceExtractorInputV1): Promise<unknown> {
    const { system, user } = buildEvidenceExtractionMessages(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    metrics.recordLlmCall();
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new EvidenceExtractionError('provider_error', `DeepSeek HTTP ${response.status}`);
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content)
        throw new EvidenceExtractionError('provider_error', 'DeepSeek returned no content');
      try {
        return JSON.parse(content) as unknown;
      } catch {
        throw new EvidenceExtractionError('invalid_output', 'DeepSeek returned invalid JSON');
      }
    } catch (error) {
      metrics.recordLlmFailure();
      if (error instanceof EvidenceExtractionError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new EvidenceExtractionError('provider_timeout', 'DeepSeek extraction timed out');
      }
      throw new EvidenceExtractionError('provider_error', 'DeepSeek extraction failed');
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Keyless/compliance-off behavior is fail closed; unlike LLM1 there is no heuristic extraction. */
export class UnavailableEvidenceExtractor implements EvidenceExtractorPort {
  readonly name = 'unavailable';
  readonly model = null;

  async extract(_input: EvidenceExtractorInputV1): Promise<never> {
    throw new EvidenceExtractionError('provider_unavailable');
  }
}
