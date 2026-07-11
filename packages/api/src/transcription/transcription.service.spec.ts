import { describe, it, expect } from 'vitest';
import { TranscriptionService } from './transcription.service';
import type { TranscriptionRepository, VoiceEvidence, TranscriptionLogRow } from './transcription.repository';
import type { ObjectsService } from '../objects/objects.service';
import type { LlmListenerService, AnalyzeTextInput } from '../listener/listener.service';
import type { StoragePort } from '../storage/storage.provider';
import type { TranscriptionResult, Transcriber } from './transcription.types';

/**
 * ⛔ MOAT + reliability unit tests for T4. The service may only annotate the source Document with a
 * derived `transcript` (properties) and feed a CONFIDENT transcript to LLM1 — NOTHING else. These
 * fakes assert: no state-triplet write ever happens here, failures/low-confidence are marked without
 * fabricating text, the original audio is never rewritten, and LLM1 is fed only on `done`.
 * Deterministic, no DB, no network.
 */
const VOICE: VoiceEvidence = { id: 'doc-voice-1', type: 'Document', kind: 'voice', mime: 'audio/m4a', storageKey: 'tenant/t/abc.m4a', locale: 'zh', transcriptStatus: null };

function makeService(
  result: TranscriptionResult,
  evidence: VoiceEvidence | null = VOICE,
  storageReadThrows = false,
) {
  const updates: Array<{ id: string; input: Record<string, unknown> }> = [];
  const logs: TranscriptionLogRow[] = [];
  const events: Array<{ objectId: string; type: string; payload: Record<string, unknown> }> = [];
  const analyzeCalls: AnalyzeTextInput[] = [];
  let putCalled = false;
  let readCalled = false;

  const transcriber: Transcriber = { name: result.provider, transcribe: async () => result };
  const storage = {
    read: async () => { readCalled = true; if (storageReadThrows) throw new Error('storage down'); return Buffer.from('AUDIO'); },
    put: async () => { putCalled = true; },
    getSignedUrl: async () => ({ url: '', expiresAt: '' }),
    head: async () => ({ exists: true, size: 5 }),
  } as unknown as StoragePort;
  const repo = {
    loadVoiceEvidence: async () => (evidence ? { ...evidence } : null),
    logTranscription: async (_t: string, row: TranscriptionLogRow) => { logs.push(row); },
    recordEvent: async (_t: string, objectId: string, type: string, payload: Record<string, unknown>) => { events.push({ objectId, type, payload }); },
  } as unknown as TranscriptionRepository;
  const objects = {
    update: async (_t: string, id: string, input: Record<string, unknown>) => { updates.push({ id, input }); return {} as never; },
  } as unknown as ObjectsService;
  const listener = {
    analyzeText: async (_t: string, input: AnalyzeTextInput) => { analyzeCalls.push(input); return null; },
  } as unknown as LlmListenerService;

  const svc = new TranscriptionService(transcriber, storage, repo, objects, listener);
  return { svc, updates, logs, events, analyzeCalls, put: () => putCalled, read: () => readCalled };
}

const ok = (over: Partial<TranscriptionResult> = {}): TranscriptionResult => ({
  status: 'done', text: '3号房已为下一位患者备好', language: 'zh', confidence: 0.9, provider: 'mock', model: 'mock', ...over,
});

describe('TranscriptionService — moat + reliability', () => {
  it('stores a confident transcript as a derived field and feeds it to LLM1 (never touches state)', async () => {
    const { svc, updates, logs, events, analyzeCalls } = makeService(ok());
    const status = await svc.transcribe('tenant-a', 'doc-voice-1');

    expect(status).toBe('done');
    // One write: the transcript annotation on the SOURCE document, properties-only.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.id).toBe('doc-voice-1');
    expect(Object.keys(updates[0]!.input)).toEqual(['properties']);
    const transcript = (updates[0]!.input as { properties: { transcript: Record<string, unknown> } }).properties.transcript;
    expect(transcript).toMatchObject({ status: 'done', text: '3号房已为下一位患者备好', provider: 'mock' });

    // The moat: the STT service NEVER writes claimed/verified/confidence to the state triplet.
    for (const u of updates) {
      expect('claimedState' in u.input).toBe(false);
      expect('verifiedState' in u.input).toBe(false);
      expect('confidence' in u.input).toBe(false);
    }

    // Fed to LLM1 as this report's text (reuses the existing analyze/claim path).
    expect(analyzeCalls).toHaveLength(1);
    expect(analyzeCalls[0]).toMatchObject({ objectId: 'doc-voice-1', text: '3号房已为下一位患者备好', reportType: 'voice' });

    expect(logs[0]).toMatchObject({ status: 'done', provider: 'mock', chars: '3号房已为下一位患者备好'.length });
    expect(events[0]).toMatchObject({ type: 'transcript.completed', objectId: 'doc-voice-1' });
  });

  it('marks a provider failure without fabricating text, and does NOT feed LLM1', async () => {
    const { svc, updates, logs, events, analyzeCalls, put } = makeService(
      { status: 'failed', text: null, language: null, confidence: null, provider: 'openai', model: 'whisper-1', error: 'HTTP 500' },
    );
    const status = await svc.transcribe('tenant-a', 'doc-voice-1');

    expect(status).toBe('failed');
    const transcript = (updates[0]!.input as { properties: { transcript: Record<string, unknown> } }).properties.transcript;
    expect(transcript.text).toBeNull(); // never invents text
    expect(transcript.status).toBe('failed');
    expect(analyzeCalls).toHaveLength(0); // garbage is not fed downstream
    expect(events[0]!.type).toBe('transcript.failed');
    expect(logs[0]).toMatchObject({ status: 'failed', chars: 0 });
    expect(put()).toBe(false); // original audio is never rewritten
  });

  it('marks low-confidence transcripts and withholds them from LLM1', async () => {
    const { svc, updates, analyzeCalls } = makeService(ok({ confidence: 0.3 }));
    const status = await svc.transcribe('tenant-a', 'doc-voice-1');
    expect(status).toBe('low_confidence');
    const transcript = (updates[0]!.input as { properties: { transcript: Record<string, unknown> } }).properties.transcript;
    expect(transcript.status).toBe('low_confidence');
    expect(transcript.text).toBeTruthy(); // kept + shown, but marked
    expect(analyzeCalls).toHaveLength(0); // not promoted to a claim
  });

  it('records unavailable (keyless) without fabricating and keeps the audio', async () => {
    const { svc, updates, analyzeCalls, put } = makeService(
      { status: 'unavailable', text: null, language: null, confidence: null, provider: 'null', model: null, error: 'no STT provider configured' },
    );
    const status = await svc.transcribe('tenant-a', 'doc-voice-1');
    expect(status).toBe('unavailable');
    expect((updates[0]!.input as { properties: { transcript: { text: unknown } } }).properties.transcript.text).toBeNull();
    expect(analyzeCalls).toHaveLength(0);
    expect(put()).toBe(false);
  });

  it('treats a storage read error as a retryable failure (no fabrication)', async () => {
    const { svc, updates, analyzeCalls } = makeService(ok(), VOICE, /* storageReadThrows */ true);
    const status = await svc.transcribe('tenant-a', 'doc-voice-1');
    expect(status).toBe('failed');
    expect((updates[0]!.input as { properties: { transcript: { text: unknown } } }).properties.transcript.text).toBeNull();
    expect(analyzeCalls).toHaveLength(0);
  });

  it('skips non-voice objects and already-transcribed objects (idempotent)', async () => {
    const notVoice = await makeService(ok(), { ...VOICE, kind: 'photo', mime: 'image/jpeg' }).svc.transcribe('t', 'x');
    expect(notVoice).toBe('skipped');
    const alreadyDone = await makeService(ok(), { ...VOICE, transcriptStatus: 'done' }).svc.transcribe('t', 'x');
    expect(alreadyDone).toBe('skipped');
  });

  it('re-runs a completed transcript when force=true', async () => {
    const { svc, updates } = makeService(ok(), { ...VOICE, transcriptStatus: 'done' });
    const status = await svc.transcribe('tenant-a', 'doc-voice-1', { force: true });
    expect(status).toBe('done');
    expect(updates).toHaveLength(1);
  });
});
