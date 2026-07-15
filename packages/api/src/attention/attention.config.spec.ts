import { describe, it, expect } from 'vitest';
import { resolveAttentionConfig, ATTENTION_DEFAULTS } from './attention.config';

describe('resolveAttentionConfig', () => {
  it('uses the product-confirmed defaults when env is empty', () => {
    const cfg = resolveAttentionConfig({});
    expect(cfg.silenceSeconds).toBe(3600);
    expect(cfg.scanFollowupSeconds).toBe(1800);
    expect(cfg.displayCooldownSeconds).toBe(7200);
    expect(cfg.busyInconsistencySeconds).toBe(600);
    expect(cfg.lowConfidenceThreshold).toBe(0.6);
    expect(cfg).toEqual(ATTENTION_DEFAULTS);
  });

  it('reads every threshold from env — nothing is hardcoded', () => {
    const cfg = resolveAttentionConfig({
      ATTENTION_SILENCE_SECONDS: '900',
      ATTENTION_BUSY_WINDOW_SECONDS: '120',
      ATTENTION_SCAN_FOLLOWUP_SECONDS: '300',
      ATTENTION_LOW_CONFIDENCE_THRESHOLD: '0.8',
      ATTENTION_DISPLAY_COOLDOWN_SECONDS: '3600',
    });
    expect(cfg.silenceSeconds).toBe(900);
    expect(cfg.busyInconsistencySeconds).toBe(120);
    expect(cfg.scanFollowupSeconds).toBe(300);
    expect(cfg.lowConfidenceThreshold).toBe(0.8);
    expect(cfg.displayCooldownSeconds).toBe(3600);
  });

  it('falls back to defaults on invalid / non-positive values', () => {
    const cfg = resolveAttentionConfig({
      ATTENTION_SILENCE_SECONDS: 'abc',
      ATTENTION_BUSY_WINDOW_SECONDS: '0',
      ATTENTION_SCAN_FOLLOWUP_SECONDS: '-5',
    });
    expect(cfg.silenceSeconds).toBe(3600);
    expect(cfg.busyInconsistencySeconds).toBe(600);
    expect(cfg.scanFollowupSeconds).toBe(1800);
  });

  it('clamps the confidence threshold into 0..1', () => {
    expect(resolveAttentionConfig({ ATTENTION_LOW_CONFIDENCE_THRESHOLD: '2' }).lowConfidenceThreshold).toBe(1);
    expect(resolveAttentionConfig({ ATTENTION_LOW_CONFIDENCE_THRESHOLD: '-1' }).lowConfidenceThreshold).toBe(0);
  });
});
