import { describe, it, expect } from 'vitest';
import { resolveRetentionConfig, RETENTION_DEFAULTS } from './retention.config';

describe('resolveRetentionConfig', () => {
  it('uses the provisional 30-day default when env is empty', () => {
    const cfg = resolveRetentionConfig({});
    expect(cfg.rawContentDays).toBe(30);
    expect(cfg).toEqual(RETENTION_DEFAULTS);
  });

  it('reads the window from env — the retention period is NOT hardcoded', () => {
    expect(resolveRetentionConfig({ RETENTION_RAW_CONTENT_DAYS: '7' }).rawContentDays).toBe(7);
    expect(resolveRetentionConfig({ RETENTION_RAW_CONTENT_DAYS: '90' }).rawContentDays).toBe(90);
  });

  it('falls back to the default on invalid / non-positive values', () => {
    expect(resolveRetentionConfig({ RETENTION_RAW_CONTENT_DAYS: 'abc' }).rawContentDays).toBe(30);
    expect(resolveRetentionConfig({ RETENTION_RAW_CONTENT_DAYS: '0' }).rawContentDays).toBe(30);
    expect(resolveRetentionConfig({ RETENTION_RAW_CONTENT_DAYS: '-5' }).rawContentDays).toBe(30);
    expect(resolveRetentionConfig({ RETENTION_RAW_CONTENT_DAYS: '' }).rawContentDays).toBe(30);
  });
});
