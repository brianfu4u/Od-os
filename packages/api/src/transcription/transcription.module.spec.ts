import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTranscriber } from './transcription.module';

/**
 * P1-6-c · boot-selection guardrail for the STT adapter. makeTranscriber reads process.env directly,
 * so we snapshot + restore the vars it consults. Key point: the compliance switch
 * (COMPLIANCE_EXTERNAL_PROVIDERS=off) MUST pin the NullTranscriber even when STT_API_KEY is present,
 * so no audio leaves the box. The explicit `mock` opt-in (no external call) is left untouched.
 */
const KEYS = ['STT_PROVIDER', 'STT_API_KEY', 'COMPLIANCE_EXTERNAL_PROVIDERS'] as const;

describe('makeTranscriber — external STT selection + compliance downgrade', () => {
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

  it('keyless → null (declines, never fabricates text)', () => {
    expect(makeTranscriber().name).toBe('null');
  });

  it('openai + key → openai (today behaviour, switch absent)', () => {
    process.env.STT_API_KEY = 'sk-test';
    expect(makeTranscriber().name).toBe('openai');
  });

  it('COMPLIANCE_EXTERNAL_PROVIDERS=off pins null EVEN WITH a key (no audio leaves the box)', () => {
    process.env.STT_API_KEY = 'sk-test';
    process.env.COMPLIANCE_EXTERNAL_PROVIDERS = 'off';
    expect(makeTranscriber().name).toBe('null');
  });

  it('explicit mock opt-in is a local deterministic adapter, unaffected by the compliance switch', () => {
    process.env.STT_PROVIDER = 'mock';
    process.env.COMPLIANCE_EXTERNAL_PROVIDERS = 'off';
    expect(makeTranscriber().name).toBe('mock');
  });

  it('a non-off compliance value does not disable external (fails open to today behaviour)', () => {
    process.env.STT_API_KEY = 'sk-test';
    process.env.COMPLIANCE_EXTERNAL_PROVIDERS = 'on';
    expect(makeTranscriber().name).toBe('openai');
  });
});
