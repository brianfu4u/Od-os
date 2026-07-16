/**
 * P7/T4 · Voice-transcript feed contract (read-only). Shared by the API (GET /transcription/feed)
 * and the web command center so the client no longer pulls every Document + Task to render the
 * voice panel — the backend returns just the tenant's voice evidence plus each transcript's
 * cross-verification verdict (joined server-side, RLS-scoped).
 *
 * ⛔ MOAT: this is a READ projection only. The verdict is the Task's `verifiedState` (owned by the
 * deterministic engine, S2) — never derived from the transcript. The raw `properties` (incl.
 * `transcript` + `llm`) are returned so the client keeps its pure view-model + claim derivation.
 */
export interface VoiceFeedVerdict {
  /** verified | conflict | pending | unverified (from the driving Task; the only "verified" source). */
  verifiedState: string;
  /**
   * Deterministic S2 verdict score in [0,1] (RULE score, not a probability). Renamed from
   * `confidence` in P1-4. DISTINCT from the STT transcription confidence (that stays `confidence`
   * on the transcription_log / VoiceFeedRecord.properties.llm — a different concept, kept on purpose).
   */
  verificationScore: number | null;
}

export interface VoiceFeedRecord {
  /** The voice evidence Document id (the retry target). */
  objectId: string;
  /** Best timestamp for ordering (transcript time, else the object's updatedAt). */
  at: string | null;
  /** The voice Document's JSONB properties (includes `kind`, `transcript`, `llm`, `storageKey`, …). */
  properties: Record<string, unknown>;
  /** Verdict of the Task this transcript's claim drove (LEFT JOIN on Task.properties.claimedBy), or null. */
  verdict: VoiceFeedVerdict | null;
}
