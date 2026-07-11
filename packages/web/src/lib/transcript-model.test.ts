import { describe, expect, it } from 'vitest';
import { buildTranscriptFeed, transcriptView, type ObjectRow, type TranscriptFeedItem } from './transcript-model';
import { syntheticFeedItems } from './synthetic-transcripts';

function voiceDoc(id: string, transcript: unknown, extra: Record<string, unknown> = {}): ObjectRow {
  return { id, type: 'Document', properties: { kind: 'voice', mime: 'audio/m4a', transcript, ...extra }, updatedAt: '2026-07-11T00:00:00.000Z' };
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
    expect(v.text).toBe('<b>x</b><script>alert(1)</script>'); // never parsed/stripped → escaped by React {text}
  });
});

describe('buildTranscriptFeed — provenance & the moat', () => {
  it('links a transcript to its claim (LLM1) and to its verdict (Task, the only verified source)', () => {
    const doc = voiceDoc('doc-1', { text: '3号房已备好', status: 'done', at: '2026-07-11T01:00:00.000Z' }, {
      llm: { claim: { taskType: 'room_turnover', claimedState: 'ready' } },
    });
    const task: ObjectRow = { id: 'task-1', type: 'Task', properties: { claimedBy: 'doc-1' }, verifiedState: 'verified', confidence: 0.855 };

    const [item] = buildTranscriptFeed([doc], [task]);
    expect(item!.transcript.status).toBe('done');
    expect(item!.claim).toEqual({ taskType: 'room_turnover', claimedState: 'ready' });
    expect(item!.verdict).toEqual({ verifiedState: 'verified', confidence: 0.855 });
  });

  it('a transcript alone yields NO verdict — the verdict comes only from a Task', () => {
    const doc = voiceDoc('doc-2', { text: '3号房已备好', status: 'done' }, { llm: { claim: { taskType: 'room_turnover', claimedState: 'ready' } } });
    const [item] = buildTranscriptFeed([doc], []); // no tasks → no verdict
    expect(item!.claim).not.toBeNull();
    expect(item!.verdict).toBeNull();
    // The transcript view itself never carries a "verified" flag — only status + STT confidence.
    expect(Object.values(item!.transcript)).not.toContain('verified');
  });

  it('excludes non-voice documents', () => {
    const photo: ObjectRow = { id: 'p', type: 'Document', properties: { kind: 'photo', mime: 'image/jpeg' } };
    expect(buildTranscriptFeed([photo], [])).toHaveLength(0);
  });

  it('failed/low-confidence transcripts carry no claim', () => {
    const failed = voiceDoc('doc-f', { status: 'failed', error: 'HTTP 500' });
    const [item] = buildTranscriptFeed([failed], []);
    expect(item!.transcript.retryable).toBe(true);
    expect(item!.claim).toBeNull();
  });

  it('sorts newest first', () => {
    const a = voiceDoc('a', { status: 'done', text: 'a', at: '2026-07-11T01:00:00.000Z' });
    const b = voiceDoc('b', { status: 'done', text: 'b', at: '2026-07-11T03:00:00.000Z' });
    const ids = buildTranscriptFeed([a, b], []).map((i) => i.id);
    expect(ids).toEqual(['b', 'a']);
  });
});

describe('synthetic shim gate', () => {
  it('adds nothing when the gate is off (no synthetic/placeholder leaks)', () => {
    const items = buildTranscriptFeed([], [], { synthetic: false, syntheticItems: syntheticFeedItems() });
    expect(items).toHaveLength(0);
  });

  it('appends flagged demo items only when the gate is on', () => {
    const items: TranscriptFeedItem[] = buildTranscriptFeed([], [], { synthetic: true, syntheticItems: syntheticFeedItems() });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.synthetic === true)).toBe(true);
  });
});
