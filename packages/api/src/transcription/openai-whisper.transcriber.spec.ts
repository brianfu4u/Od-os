import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAiWhisperTranscriber } from './openai-whisper.transcriber';

/**
 * Unit tests for the Whisper adapter. Network is mocked (no real calls). We pin: the request shape
 * (endpoint + Bearer auth + multipart model/format/language), success parsing (text/language/
 * confidence), and that provider/transport errors return a `failed` result (never throw, never
 * fabricate text). The key is passed to the constructor — DEEPSEEK_* env is never consulted.
 */
function mockFetch(impl: () => { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  const fn = vi.fn(async () => impl() as unknown as Response);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
});

const adapter = () => new OpenAiWhisperTranscriber('test-key', 'https://stt.example/v1', 'whisper-1', 5000);

describe('OpenAiWhisperTranscriber', () => {
  it('posts multipart to /audio/transcriptions with Bearer auth and parses a verbose_json result', async () => {
    const fn = mockFetch(() => ({ ok: true, json: async () => ({ text: '3号房已备好', language: 'zh', segments: [{ avg_logprob: -0.1, no_speech_prob: 0.0 }] }) }));
    const res = await adapter().transcribe({ bytes: Buffer.from('AUDIO'), mime: 'audio/m4a', languageHint: 'zh' });

    expect(res.status).toBe('done');
    expect(res.text).toBe('3号房已备好');
    expect(res.language).toBe('zh');
    expect(res.provider).toBe('openai');
    expect(res.model).toBe('whisper-1');
    expect(res.confidence).toBeGreaterThan(0.8);

    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://stt.example/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBe('Bearer test-key');
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined(); // fetch sets the multipart boundary
    const body = init.body as unknown as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('model')).toBe('whisper-1');
    expect(body.get('response_format')).toBe('verbose_json');
    expect(body.get('language')).toBe('zh');
  });

  it('returns failed (not throw) on a non-2xx response', async () => {
    mockFetch(() => ({ ok: false, status: 500, json: async () => ({}) }));
    const res = await adapter().transcribe({ bytes: Buffer.from('x'), mime: 'audio/m4a' });
    expect(res.status).toBe('failed');
    expect(res.text).toBeNull();
    expect(res.error).toContain('500');
  });

  it('treats an empty transcript as failed (no fabrication)', async () => {
    mockFetch(() => ({ ok: true, json: async () => ({ text: '   ', language: 'zh' }) }));
    const res = await adapter().transcribe({ bytes: Buffer.from('x'), mime: 'audio/m4a' });
    expect(res.status).toBe('failed');
    expect(res.text).toBeNull();
    expect(res.error).toBe('empty transcript');
  });

  it('returns failed when the network throws', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const res = await adapter().transcribe({ bytes: Buffer.from('x'), mime: 'audio/m4a' });
    expect(res.status).toBe('failed');
    expect(res.text).toBeNull();
    expect(res.error).toContain('ECONNRESET');
  });
});
