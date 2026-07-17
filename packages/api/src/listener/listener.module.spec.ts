import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEvidenceExtractor, makeListener } from './listener.module';

/**
 * P1-6-c · boot-selection guardrail for the LLM1 adapter. makeListener reads process.env directly,
 * so we snapshot + restore the three vars it consults. The key point: the compliance switch
 * (COMPLIANCE_EXTERNAL_PROVIDERS=off) MUST pin the heuristic even when DEEPSEEK_API_KEY is present.
 */
const KEYS = ['DEEPSEEK_API_KEY', 'LLM_LISTENER', 'COMPLIANCE_EXTERNAL_PROVIDERS'] as const;

describe('makeListener — external LLM selection + compliance downgrade', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('keyless → heuristic (safe default in dev/CI/tests)', () => {
    expect(makeListener().name).toBe('heuristic');
  });

  it('with a key → deepseek (today behaviour, switch absent)', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    expect(makeListener().name).toBe('deepseek');
  });

  it('LLM_LISTENER=heuristic pins heuristic even with a key', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    process.env.LLM_LISTENER = 'heuristic';
    expect(makeListener().name).toBe('heuristic');
  });

  it('COMPLIANCE_EXTERNAL_PROVIDERS=off pins heuristic EVEN WITH a key (no transcript leaves the box)', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    process.env.COMPLIANCE_EXTERNAL_PROVIDERS = 'off';
    expect(makeListener().name).toBe('heuristic');
  });

  it('a non-off compliance value does not disable external (fails open to today behaviour)', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    process.env.COMPLIANCE_EXTERNAL_PROVIDERS = 'on';
    expect(makeListener().name).toBe('deepseek');
  });
});

describe('makeEvidenceExtractor — T-13A fail-closed provider selection', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('keyless uses an unavailable adapter, never a heuristic extractor', () => {
    expect(makeEvidenceExtractor().name).toBe('unavailable');
  });

  it('selects DeepSeek only when external processing is enabled and keyed', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test';
    expect(makeEvidenceExtractor().name).toBe('deepseek');
    process.env.LLM_LISTENER = 'heuristic';
    expect(makeEvidenceExtractor().name).toBe('unavailable');
    delete process.env.LLM_LISTENER;
    process.env.COMPLIANCE_EXTERNAL_PROVIDERS = 'off';
    expect(makeEvidenceExtractor().name).toBe('unavailable');
  });
});
