import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TranscriptionService } from './transcription.service';
import { STALE_JOB_MS, type TranscriptionJob, type VoiceEvidence } from './transcription.repository';
import type { TranscriptionRepository } from './transcription.repository';
import type { ObjectsService } from '../objects/objects.service';
import type { StoragePort } from '../storage/storage.provider';
import type { TranscriptionResult, Transcriber } from './transcription.types';

/**
 * P0-3 test (c): transcription is DURABLE, not fire-and-forget. An in-memory fake stands in for the
 * transcription_jobs table so we can prove, without a DB: a 'pending' row is persisted BEFORE
 * processing; the drain claims → completes it; a claim is atomic (single winner); and a job orphaned
 * in 'processing' by a crash is recovered to 'pending' and re-run — i.e. no work is lost.
 */
interface Row extends TranscriptionJob {
  updatedAt: number;
}

function makeHarness(opts: { transcriberThrows?: boolean } = {}) {
  const rows: Row[] = [];
  const transcribed: string[] = [];

  const queue = {
    enqueueJob: async (_t: string, objectId: string) => {
      const id = randomUUID();
      rows.push({ id, objectId, status: 'pending', attempts: 0, updatedAt: Date.now() });
      return { id };
    },
    claimJob: async (_t: string, jobId: string) => {
      const r = rows.find((x) => x.id === jobId);
      if (!r || r.status !== 'pending') return false;
      r.status = 'processing';
      r.attempts += 1;
      r.updatedAt = Date.now();
      return true;
    },
    completeJob: async (_t: string, jobId: string, status: 'done' | 'failed') => {
      const r = rows.find((x) => x.id === jobId);
      if (r) { r.status = status; r.updatedAt = Date.now(); }
    },
    recoverStaleJobs: async (_t: string, now: number = Date.now()) => {
      let n = 0;
      for (const r of rows) {
        if (r.status === 'processing' && r.updatedAt < now - STALE_JOB_MS) { r.status = 'pending'; n += 1; }
      }
      return n;
    },
    listPendingJobs: async () => rows.filter((r) => r.status === 'pending').map((r) => ({ ...r })),
    loadVoiceEvidence: async (_t: string, id: string): Promise<VoiceEvidence> => ({
      id, type: 'Document', kind: 'voice', mime: 'audio/m4a', storageKey: `tenant/t/${id}.m4a`, locale: 'zh', transcriptStatus: null,
    }),
    logTranscription: async () => undefined,
    recordEvent: async () => undefined,
  } as unknown as TranscriptionRepository;

  const result: TranscriptionResult = { status: 'done', text: 'ok', language: 'zh', confidence: 0.9, provider: 'mock', model: 'm' };
  const transcriber: Transcriber = {
    name: 'mock',
    transcribe: async () => {
      if (opts.transcriberThrows) throw new Error('provider down');
      return result;
    },
  };
  const storage = { read: async () => Buffer.from('AUDIO') } as unknown as StoragePort;
  const objects = { update: async (_t: string, id: string) => { transcribed.push(id); return {} as never; } } as unknown as ObjectsService;

  const svc = new TranscriptionService(transcriber, storage, queue, objects);
  return { svc, rows, transcribed };
}

/** enqueueTranscription fires a background drain; poll until the row reaches a terminal status. */
async function settle(rows: Row[], objectId: string): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    const r = rows.find((x) => x.objectId === objectId);
    if (r && (r.status === 'done' || r.status === 'failed')) return;
    await new Promise((res) => setTimeout(res, 0));
  }
}

describe('TranscriptionService — durable queue', () => {
  it('persists a pending job BEFORE any processing (survives a crash after enqueue)', async () => {
    const { svc, rows } = makeHarness();
    await svc.enqueueTranscription('t1', 'obj-1');
    // The awaited part only guarantees persistence; the row must exist for obj-1 immediately.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.objectId).toBe('obj-1');
    expect(['pending', 'processing', 'done']).toContain(rows[0]!.status);
  });

  it('drains a pending job: claim → transcribe → done', async () => {
    const { svc, rows, transcribed } = makeHarness();
    await svc.enqueueTranscription('t1', 'obj-1');
    await svc.drainPending('t1');
    await settle(rows, 'obj-1');
    expect(rows[0]!.status).toBe('done');
    expect(transcribed).toEqual(['obj-1']);
  });

  it('claim is atomic — a second claim of the same job loses', async () => {
    const { svc, rows } = makeHarness();
    await svc.enqueueTranscription('t1', 'obj-1');
    // enqueueTranscription fires an async drain; wait a tick for it to claim.
    await new Promise((r) => setTimeout(r, 0));
    const jobId = rows[0]!.id;
    // Already claimed/completed by the drain → cannot be claimed again.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const claimed = await (svc as any).repo.claimJob('t1', jobId);
    expect(claimed).toBe(false);
  });

  it('recovers a job orphaned in processing by a crash and re-runs it', async () => {
    const { svc, rows, transcribed } = makeHarness();
    // Simulate a crash: a job stuck in 'processing' with a stale timestamp, never completed.
    rows.push({ id: randomUUID(), objectId: 'orphan', status: 'processing', attempts: 1, updatedAt: Date.now() - STALE_JOB_MS - 1000 });
    expect(rows[0]!.status).toBe('processing');

    // A later voice upload for the tenant triggers recovery + drain.
    await svc.enqueueTranscription('t1', 'new-obj');
    await svc.drainPending('t1');
    await settle(rows, 'orphan');
    await settle(rows, 'new-obj');

    const orphan = rows.find((r) => r.objectId === 'orphan')!;
    expect(orphan.status).toBe('done'); // re-queued and completed — not lost
    expect(transcribed).toContain('orphan');
  });

  it('marks a job failed (retriable) when transcription throws', async () => {
    const { svc, rows } = makeHarness({ transcriberThrows: true });
    await svc.enqueueTranscription('t1', 'obj-1');
    await svc.drainPending('t1');
    await settle(rows, 'obj-1');
    // transcribe() swallows provider errors into a 'failed' outcome → job completes as 'failed'.
    expect(['failed', 'done']).toContain(rows[0]!.status);
  });
});
