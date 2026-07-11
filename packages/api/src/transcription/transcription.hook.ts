/**
 * Decoupling seam between uploads and transcription (mirrors verification.hook). The uploads module
 * depends only on this token/interface, so it can fire STT after a voice upload commits WITHOUT a
 * hard dependency on the transcription implementation (avoids a module cycle and keeps the upload
 * response fast — the call is fire-and-forget, best-effort).
 */
export const TRANSCRIPTION_HOOK = 'TRANSCRIPTION_HOOK';

export interface TranscriptionHook {
  /**
   * Transcribe a freshly uploaded voice evidence object. Best-effort and non-blocking for the
   * caller: it must never throw back into the upload path. Async processing (network STT call)
   * happens off the request's critical path.
   */
  transcribeObject(tenantId: string, objectId: string): Promise<void>;
}
