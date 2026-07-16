/**
 * Decoupling seam between uploads and transcription (mirrors verification.hook). The uploads module
 * depends only on this token/interface, so it can fire STT after a voice upload commits WITHOUT a
 * hard dependency on the transcription implementation (avoids a module cycle and keeps the upload
 * response fast — the call is fire-and-forget, best-effort).
 */
export const TRANSCRIPTION_HOOK = 'TRANSCRIPTION_HOOK';

export interface TranscriptionHook {
  /**
   * Durably enqueue transcription for a freshly uploaded voice evidence object (P0-3). Awaiting this
   * only persists a 'pending' job row (fast) — the actual STT call runs off the request's critical
   * path. Best-effort: it must never throw back into the upload path. Because the job is persisted
   * BEFORE processing, a crash mid-transcription no longer loses the work (it is recoverable).
   */
  enqueueTranscription(tenantId: string, objectId: string): Promise<void>;
}
