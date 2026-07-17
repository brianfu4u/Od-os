import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeepSeekEvidenceExtractor } from './deepseek-evidence-extractor';
import { EvidenceExtractionError } from './evidence-extraction.types';

const input = {
  schemaVersion: 1 as const,
  modality: 'text' as const,
  content: '3号房已经准备好了',
  occurredAt: '2026-07-17T01:02:03.000Z',
  locale: 'zh' as const,
  context: { domain: 'patient_flow', taskType: 'room_turnover' },
};

describe('DeepSeekEvidenceExtractor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the existing JSON endpoint while sending no claim/expected/verdict field', async () => {
    const raw = {
      schemaVersion: 1,
      summary: '备注报告诊室已准备。',
      extractions: [],
      ambiguities: [],
      llmConfidence: 0.7,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(raw) } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const extractor = new DeepSeekEvidenceExtractor(
      'secret-test-key',
      'https://llm.test',
      'model-v1',
    );
    await expect(extractor.extract(input)).resolves.toEqual(raw);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://llm.test/chat/completions');
    const body = JSON.parse(String(options.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMessage = body.messages.find((message) => message.role === 'user')!.content;
    expect(userMessage).toContain('3号房已经准备好了');
    expect(userMessage).not.toMatch(
      /claimedStatus|claimedState|expectedState|verificationResult|verificationScore/,
    );
  });

  it('maps malformed provider JSON to invalid_output instead of falling back', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'not-json' } }] }),
      }),
    );
    const extractor = new DeepSeekEvidenceExtractor(
      'secret-test-key',
      'https://llm.test',
      'model-v1',
    );
    try {
      await extractor.extract(input);
      throw new Error('expected invalid_output');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceExtractionError);
      expect((error as EvidenceExtractionError).code).toBe('invalid_output');
    }
  });

  it('maps a transport failure to provider_error without exposing the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('sensitive upstream detail')));
    const extractor = new DeepSeekEvidenceExtractor(
      'secret-test-key',
      'https://llm.test',
      'model-v1',
    );
    await expect(extractor.extract(input)).rejects.toMatchObject({
      code: 'provider_error',
      message: 'DeepSeek extraction failed',
    });
  });
});
