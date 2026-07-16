/**
 * P7 · T4 Speech-to-Text service. Turns an uploaded voice clip into text, stores it as a DERIVED
 * field on the source voice Document (the original audio is always retained), and feeds a confident
 * transcript to the EXISTING LLM1 «Listen» layer as that report's text — so the transcript flows
 * through LLM1's analyze → classify → CLAIM path and into the deterministic cross-verification
 * pipeline, exactly like a typed report. T4 does NOT re-implement claim extraction.
 *
 * ⛔ MOAT: this service only ever calls ObjectsService.update({ properties }) (a derived transcript
 * annotation) — it has no path to verified_state. The claim (if any) is applied by LLM1, and the
 * verdict remains owned by the deterministic engine (S2).
 *
 * Reliability (docs/22): transcription is async and never blocks the upload; failures / low
 * confidence are marked explicitly and are retryable; we NEVER fabricate text; the original audio is
 * never touched. Everything runs inside withTenant() so tenant isolation holds.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { VoiceFeedRecord } from '@clearview/shared';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.provider';
import { ObjectsService } from '../objects/objects.service';
import { LlmListenerService } from '../listener/listener.service';
import { TranscriptionRepository } from './transcription.repository';
import { TRANSCRIBER, type Transcriber, type TranscriptionResult, type TranscriptionStatus } from './transcription.types';
import type { TranscriptionHook } from './transcription.hook';

/** Below this STT confidence a transcript is marked low_confidence and NOT fed to LLM1 as a claim. */
const DEFAULT_MIN_CONFIDENCE = 0.5;

export type TranscriptionOutcome = TranscriptionStatus | 'skipped';

@Injectable()
export class TranscriptionService implements TranscriptionHook {
  private readonly logger = new Logger(TranscriptionService.name);
  private readonly minConfidence = clamp01(Number(process.env.STT_MIN_CONFIDENCE ?? DEFAULT_MIN_CONFIDENCE));

  constructor(
    @Inject(TRANSCRIBER) private readonly transcriber: Transcriber,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly repo: TranscriptionRepository,
    private readonly objects: ObjectsService,
    @Optional() private readonly listener?: LlmListenerService,
  ) {
    this.logger.log(`T4 STT active — transcriber: ${this.transcriber.name}`);
  }

  /**
   * Hook entrypoint used by uploads (P0-3). Persists a durable 'pending' job row (awaited — fast) so
   * the work survives a crash, then drains pending work off the request's critical path. Also
   * self-heals: any of THIS tenant's jobs orphaned in 'processing' by an earlier crash are re-queued
   * first. Never throws back into the upload path.
   */
  async enqueueTranscription(tenantId: string, objectId: string): Promise<void> {
    try {
      await this.repo.recoverStaleJobs(tenantId);
      await this.repo.enqueueJob(tenantId, objectId);
    } catch (err) {
      // A queue write failure must not break the upload; log and fall back to a best-effort direct run.
      this.logger.error(`enqueueTranscription failed for ${objectId}: ${msg(err)}`);
      void this.transcribeObject(tenantId, objectId);
      return;
    }
    void this.drainPending(tenantId).catch((err) => this.logger.error(`drainPending failed: ${msg(err)}`));
  }

  /** Claims and processes every currently-pending job for a tenant (claim is atomic → no dup work). */
  async drainPending(tenantId: string): Promise<void> {
    const jobs = await this.repo.listPendingJobs(tenantId);
    for (const job of jobs) {
      const claimed = await this.repo.claimJob(tenantId, job.id);
      if (!claimed) continue; // another instance took it
      try {
        const outcome = await this.transcribe(tenantId, job.objectId);
        // failed/unavailable → leave the job 'failed' (retriable); anything else is terminal success.
        const failed = outcome === 'failed' || outcome === 'unavailable';
        await this.repo.completeJob(tenantId, job.id, failed ? 'failed' : 'done', failed ? `outcome=${outcome}` : null);
      } catch (err) {
        await this.repo.completeJob(tenantId, job.id, 'failed', msg(err)).catch(() => undefined);
      }
    }
  }

  /** Direct best-effort transcription (used by the manual retry endpoint + queue-write fallback). */
  async transcribeObject(tenantId: string, objectId: string): Promise<void> {
    try {
      await this.transcribe(tenantId, objectId);
    } catch (err) {
      this.logger.error(`transcribeObject failed for ${objectId}: ${msg(err)}`);
    }
  }

  /**
   * Transcribe one voice evidence object end-to-end. Returns the final outcome (or 'skipped' when the
   * object is not transcribable / already done). Safe to call again to retry (pass force to redo a
   * previously completed transcript).
   */
  async transcribe(tenantId: string, objectId: string, opts: { force?: boolean } = {}): Promise<TranscriptionOutcome> {
    const ev = await this.repo.loadVoiceEvidence(tenantId, objectId);
    if (!ev) return 'skipped';
    const isVoice = ev.kind === 'voice' || ev.mime.startsWith('audio/');
    if (!isVoice || !ev.storageKey) return 'skipped';
    if (ev.transcriptStatus === 'done' && !opts.force) return 'skipped';

    const languageHint = ev.locale ?? process.env.STT_LANGUAGE_DEFAULT ?? 'zh';

    // 1) Transcribe. Adapters never throw for provider errors, but guard storage/IO defensively.
    let result: TranscriptionResult;
    try {
      const bytes = await this.storage.read(ev.storageKey);
      result = await this.transcriber.transcribe({ bytes, mime: ev.mime, languageHint });
    } catch (err) {
      result = { status: 'failed', text: null, language: null, confidence: null, provider: this.transcriber.name, model: null, error: msg(err) };
    }

    // 2) Apply the confidence threshold (single place). A produced transcript below the bar is kept
    //    but marked low_confidence and NOT promoted into a claim.
    let status: TranscriptionStatus = result.status;
    if (status === 'done' && result.confidence != null && result.confidence < this.minConfidence) {
      status = 'low_confidence';
    }
    const hasText = status === 'done' || status === 'low_confidence';
    const text = hasText ? result.text : null;

    // 3) Persist the transcript as a DERIVED field on the voice Document (audio untouched, merge-safe).
    await this.objects.update(tenantId, objectId, {
      properties: {
        transcript: {
          text,
          status,
          language: result.language,
          confidence: result.confidence,
          provider: result.provider,
          model: result.model,
          error: result.error ?? null,
          at: new Date().toISOString(),
        },
      },
    });

    // 4) Append-only audit + a semantic event for the command-center live stream.
    await this.repo.logTranscription(tenantId, {
      objectId,
      provider: result.provider,
      model: result.model,
      locale: result.language,
      confidence: result.confidence,
      chars: text?.length ?? 0,
      status,
      error: result.error ?? null,
    });
    await this.repo.recordEvent(tenantId, objectId, hasText ? 'transcript.completed' : 'transcript.failed', {
      status,
      provider: result.provider,
      language: result.language,
    });

    // 5) Feed a CONFIDENT transcript to the existing LLM1 layer as this report's text. LLM1 owns
    //    analyze/classify/claim; the moat (claimed_state only) stays enforced there. Low-confidence /
    //    failed transcripts are surfaced (marked) but never drive a claim.
    if (status === 'done' && text && this.listener) {
      try {
        await this.listener.analyzeText(tenantId, {
          objectId,
          text,
          reportType: 'voice',
          locale: result.language ?? ev.locale ?? undefined,
        });
      } catch (err) {
        this.logger.warn(`LLM1 analyzeText failed for transcript ${objectId}: ${msg(err)}`);
      }
    }

    if (status === 'failed' || status === 'unavailable') {
      this.logger.warn(`transcription ${status} for ${objectId} via ${result.provider}${result.error ? `: ${result.error}` : ''}`);
    }
    return status;
  }

  /**
   * Read-only, tenant-scoped voice-transcript feed for the command center (P7/T4-web follow-up):
   * voice evidence + each transcript's driving verdict, joined server-side. Replaces the client
   * pulling every Document + Task. Purely a read projection — no state writes, moat untouched.
   */
  feed(tenantId: string, limit?: number): Promise<VoiceFeedRecord[]> {
    return this.repo.listVoiceFeed(tenantId, limit ?? 100);
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : DEFAULT_MIN_CONFIDENCE;
}
function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
