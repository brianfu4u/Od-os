import { describe, expect, it } from 'vitest';
import type { VoiceFeedRecord } from '@clearview/shared';
import { buildFeed, transcriptView, type TranscriptFeedItem } from './transcript-model';
import { syntheticFeedItems } from './synthetic-transcripts';

function rec(
  objectId: string,
  transcript: unknown,
  opts: { llm?: Record<string, unknown>; verdict?: VoiceFeedRecord['verdict']; at?: string } = {},
): VoiceFeedRecord {
  const t = transcript as { at?: string } | null | undefined;
  return {
    objectId,
    at: opts.at ?? t?.at ?? '2026-07-11T00:00:00.000Z',
    properties: { kind: 'voice', mime: 'audio/m4a', transcript, ...(opts.llm ? { llm: opts.llm } : {}) },
    verdict: opts.verdict ?? null,
  };
}

describe('transcriptView — four states + graceful degrade', () => {
  it('done: shows text + STT metadata, not retryable, tone ok', () => {
    const v = transcriptView({ text: '3号房已备好', status: 'done', language: 'zh', confidence: 0.9, provider: 'openai', model: 'whisper-1', at: 'x' });
    expect(v.status).toBe('done');
    expect(v.showText).toBe(true);
    expect(v.text).toBe('3号房已备好');
    expect(v.retryable).toBe(false);
    expect(v.notApplied).toBe(false);
    expect(v.tone).toBe('ok');
    expect(v.sttConfidence).toBe(0.9);
    expect(v.provider).toBe('openai');
  });

  it('low_confidence: shows text but marked not-adopted, tone warn', () => {
    const v = transcriptView({ text: '也许好了', status: 'low_confidence', confidence: 0.3 });
    expect(v.showText).toBe(true);
    expect(v.text).toBe('也许好了');
    expect(v.notApplied).toBe(true);
    expect(v.retryable).toBe(false);
    expect(v.tone).toBe('warn');
  });

  it('failed: no text, retryable, surfaces error, tone bad', () => {
    const v = transcriptView({ text: null, status: 'failed', error: 'HTTP 500' });
    expect(v.showText).toBe(false);
    expect(v.text).toBeNull();
    expect(v.retryable).toBe(true);
    expect(v.errorText).toBe('HTTP 500');
    expect(v.tone).toBe('bad');
  });

  it('unavailable: no text, retryable, no fabricated error, tone muted', () => {
    const v = transcriptView({ text: null, status: 'unavailable' });
    expect(v.showText).toBe(false);
    expect(v.text).toBeNull();
    expect(v.retryable).toBe(true);
    expect(v.errorText).toBeNull();
    expect(v.tone).toBe('muted');
  });

  it('missing/old object: degrades to none (no throw, no text)', () => {
    const v = transcriptView(undefined);
    expect(v.status).toBe('none');
    expect(v.showText).toBe(false);
    expect(v.text).toBeNull();
    expect(v.retryable).toBe(false);
  });

  it('renders transcript text as PLAIN TEXT — HTML is returned verbatim (React escapes on render)', () => {
    const v = transcriptView({ text: '<b>x</b><script>alert(1)</script>', status: 'done' });
    expect(v.text).toBe('<b>x</b><script>alert(1)</script>');
  });
});

describe('buildFeed — scoped records → provenance & the moat', () => {
  it('derives the claim, preferring classification.taskType as a fallback (improvement 2)', () => {
    // claim carries only claimedState; taskType lives on classification → must still show.
    const r = rec('doc-1', { text: '3号房已备好', status: 'done', at: '2026-07-11T01:00:00.000Z' }, {
      llm: { claim: { claimedState: 'ready' }, classification: { taskType: 'room_turnover' } },
      verdict: { verifiedState: 'verified', verificationScore: 0.855 },
    });
    const [item] = buildFeed([r]);
    expect(item!.transcript.status).toBe('done');
    expect(item!.claim).toEqual({ taskType: 'room_turnover', claimedState: 'ready' });
    expect(item!.verdict).toEqual({ verifiedState: 'verified', verificationScore: 0.855 });
  });

  it('prefers claim.taskType when present', () => {
    const r = rec('doc-x', { text: 'done', status: 'done' }, { llm: { claim: { taskType: 'pretest_done', claimedState: 'done' }, classification: { taskType: 'room_turnover' } } });
    expect(buildFeed([r])[0]!.claim).toEqual({ taskType: 'pretest_done', claimedState: 'done' });
  });

  it('a transcript alone yields NO verdict — the verdict comes only from the record (Task)', () => {
    const r = rec('doc-2', { text: '3号房已备好', status: 'done' }, { llm: { claim: { claimedState: 'ready' }, classification: { taskType: 'room_turnover' } } });
    const [item] = buildFeed([r]); // no verdict on the record
    expect(item!.claim).not.toBeNull();
    expect(item!.verdict).toBeNull();
    expect(Object.values(item!.transcript)).not.toContain('verified');
  });

  it('omits the claim gracefully when no claimedState (failed/low-confidence)', () => {
    const failed = rec('doc-f', { status: 'failed', error: 'HTTP 500' });
    const [item] = buildFeed([failed]);
    expect(item!.transcript.retryable).toBe(true);
    expect(item!.claim).toBeNull();
  });

  it('sorts newest first', () => {
    const a = rec('a', { status: 'done', text: 'a', at: '2026-07-11T01:00:00.000Z' });
    const b = rec('b', { status: 'done', text: 'b', at: '2026-07-11T03:00:00.000Z' });
    expect(buildFeed([a, b]).map((i) => i.id)).toEqual(['b', 'a']);
  });
});

describe('synthetic shim gate', () => {
  it('adds nothing when the gate is off (no synthetic/placeholder leaks)', () => {
    expect(buildFeed([], { synthetic: false, syntheticItems: syntheticFeedItems() })).toHaveLength(0);
  });

  it('appends flagged demo items only when the gate is on', () => {
    const items: TranscriptFeedItem[] = buildFeed([], { synthetic: true, syntheticItems: syntheticFeedItems() });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.synthetic === true)).toBe(true);
  });
});
